import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateBinding } from '../schedules.mjs';
import { runHarness } from '../harnesses.mjs';
import { sha256 } from './inventory.mjs';
import { importStates } from './state.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const repairable = new Set(['invalid_json', 'invalid_state', 'broken_reference']);
function sourceEntry(journal, path) {
  if (journal.record.phase !== 'staged') throw Error('Repairs require staged originals, before fencing.');
  journal.verifyArchive();
  const entry = journal.record.manifest.files.find(file => file.path === path && file.category === 'state');
  if (!entry) throw Error('Only a known state source is repairable; ownership and schedules need human decisions.');
  return entry;
}
const ledgerPath = entry => `repairs/${sha256(entry.path)}.json`;
function load(journal, entry) {
  const path = journal.dataPath(ledgerPath(entry));
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 1048576 || (stat.mode & 0o077)) throw Error('Invalid private repair ledger.');
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (value.version !== 1 || value.source.path !== entry.path || value.source.sha256 !== entry.sha256
    || !Array.isArray(value.attempts) || value.attempts.length > 3) throw Error('Repair ledger scope changed.');
  return value;
}
const save = (journal, entry, ledger) => journal.writeData(ledgerPath(entry), Buffer.from(JSON.stringify(ledger)), { replace: true });
function view(attempt) { return clone({ status: attempt.state, attempt, proposalHash: attempt.proposalHash ?? null }); }
function parseProposal(text, entry) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 65536) throw Error('Invalid proposal.');
  const proposal = JSON.parse(text);
  if (!proposal || proposal.sourceSha256 !== entry.sha256 || !['replace_state', 'cannot_repair'].includes(proposal.action)
    || typeof proposal.explanation !== 'string' || proposal.explanation.length > 2000
    || Object.keys(proposal).some(key => !['action', 'sourceSha256', 'value', 'explanation'].includes(key))
    || (proposal.action === 'replace_state' && (!proposal.value || Array.isArray(proposal.value) || typeof proposal.value !== 'object'))) throw Error('Invalid proposal.');
  return proposal;
}

/** An agent can propose data, not approve it or loosen migration's completion checks. */
export async function requestStateRepair(journal, { sourcePath, diagnostics, consent, maxAttempts = 1, retryOf = null,
  run = runHarness, failpoint = () => {} } = {}) {
  const entry = sourceEntry(journal, sourcePath);
  if (!consent?.accepted || consent.sourcePath !== entry.path || consent.sourceSha256 !== entry.sha256
    || consent.binding?.harness !== 'pi' || !consent.binding.model?.includes('/')) throw Error('Explicit source and fully qualified Pi binding consent is required.');
  validateBinding(consent.binding);
  if (!Array.isArray(diagnostics) || !diagnostics.length || diagnostics.length > 8 || diagnostics.some(item => !repairable.has(item.code))) throw Error('This error is not repairable by an agent; a human decision is required.');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw Error('Repair attempt budget must be 1–3.');
  if (entry.size > 32768) throw Error('Repair source is too large for bounded automatic evidence; review it privately.');
  const source = { path: entry.path, sha256: entry.sha256, text: readFileSync(journal.sourcePath(entry), 'utf8') };
  const evidence = { source, diagnostics: diagnostics.map(item => ({ code: item.code, problem: String(item.problem ?? '').slice(0, 1000) })) };
  const scope = { source: { path: entry.path, sha256: entry.sha256 }, binding: clone(consent.binding), maxAttempts };
  const ledger = load(journal, entry) ?? { version: 1, ...scope, attempts: [] };
  if (!isDeepStrictEqual({ source: ledger.source, binding: ledger.binding, maxAttempts: ledger.maxAttempts }, scope)) throw Error('Repair scope or persisted budget changed.');
  const previous = ledger.attempts.at(-1);
  if (previous?.state === 'running') {
    Object.assign(previous, { state: 'interrupted', cost: null, error: 'No final receipt survived. This attempt will not be replayed.' });
    save(journal, entry, ledger);
  }
  if (previous && (['interrupted', 'proposed', 'accepted'].includes(previous.state) || retryOf !== previous.id || ledger.attempts.length >= ledger.maxAttempts)) return view(previous);
  const attempt = { id: randomUUID(), state: 'running', admittedAt: new Date().toISOString(), evidenceSha256: sha256(JSON.stringify(evidence)), cost: null };
  ledger.attempts.push(attempt);
  save(journal, entry, ledger);
  failpoint('admitted');
  const sessions = join(journal.dataRoot, 'repair-sessions');
  mkdirSync(sessions, { recursive: true, mode: 0o700 });
  let receipt;
  try {
    receipt = await run({
      ...scope.binding,
      id: attempt.id,
      purpose: 'migration-repair',
      cwd: journal.dataRoot,
      sessionFile: join(sessions, `${attempt.id}.jsonl`),
      prompt: JSON.stringify(evidence),
    });
  } catch {
    receipt = { status: 'interrupted', cost: null };
  }
  failpoint('returned');
  Object.assign(attempt, {
    finishedAt: new Date().toISOString(),
    sessionId: receipt.sessionId ?? null,
    freshSession: receipt.freshSession === true,
    cost: receipt.cost ?? null,
    state: receipt.status === 'completed' ? 'invalid_proposal' : receipt.status === 'failed' ? 'failed' : 'interrupted',
  });
  if (receipt.status === 'completed') {
    try {
      attempt.proposal = parseProposal(receipt.text, entry);
      attempt.proposalHash = sha256(JSON.stringify(attempt.proposal));
      attempt.state = attempt.proposal.action === 'replace_state' ? 'proposed' : 'cannot_repair';
    } catch {
      attempt.error = 'The model did not return a valid source-pinned proposal.';
    }
  }
  save(journal, entry, ledger);
  return view(attempt);
}

function controls(value) {
  return {
    version: value.version,
    started: value.started,
    paused: value.paused,
    stopping: value.stopping,
    enabled: value.experience?.enabled,
    generation: value.experience?.generation,
    wake: value.experience?.wake,
    pendingWake: value.experience?.pendingWake,
  };
}
export function acceptStateRepair(journal, { sourcePath, attemptId, proposalHash, confirmed, reviewedControl, otherOverrides = [] } = {}) {
  const entry = sourceEntry(journal, sourcePath);
  const ledger = load(journal, entry);
  const attempt = ledger?.attempts.find(item => item.id === attemptId);
  if (!confirmed || !reviewedControl || !attempt || !['proposed', 'accepted'].includes(attempt.state)
    || proposalHash !== attempt.proposalHash || sha256(JSON.stringify(attempt.proposal)) !== proposalHash) throw Error('Exact reviewed proposal approval, including preserved control state, is required.');
  let original;
  try {
    original = JSON.parse(readFileSync(journal.sourcePath(entry), 'utf8'));
  } catch {
    // Malformed source needs the explicit control review above.
  }
  if (original && !isDeepStrictEqual(controls(original), controls(attempt.proposal.value))) throw Error('A repair cannot change valid stop or control state.');
  const override = {
    path: entry.path,
    sha256: entry.sha256,
    value: clone(attempt.proposal.value),
    provenance: {
      repairId: attempt.id,
      proposalHash,
      approved: true,
      controlsReviewed: true,
      evidenceSha256: attempt.evidenceSha256,
    },
  };
  const validation = importStates(journal, { overrides: [...otherOverrides, override] });
  if (validation.errors.some(error => error.source?.path === entry.path || error.code === 'invalid_override')) return { status: 'invalid_proposal', validation };
  attempt.state = 'accepted';
  save(journal, entry, ledger);
  return { status: 'accepted', override, validation };
}
