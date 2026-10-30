import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inventoryLegacy, sha256 } from '../src/cli/migration/inventory.mjs';
import { MigrationJournal } from '../src/cli/migration/journal.mjs';
import { requestStateRepair, acceptStateRepair } from '../src/cli/migration/repair.mjs';

const valid = { version: 1, items: [], paused: [], started: false };
async function fixture(t, source = '{broken') {
  const root = mkdtempSync(join(tmpdir(), 'companion-repair-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), directory = join(home, '.pi/agent/companion');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${sha256('synthetic')}.json`), source);
  const manifest = inventoryLegacy({ home });
  const journal = await MigrationJournal.open(join(root, 'destination'), manifest, { selection: { sessionId: 'synthetic', sessionFile: join(root, 'session.jsonl') } });
  await journal.stage();
  t.after(() => journal.close());
  const entry = manifest.files[0];
  const consent = {
    accepted: true,
    sourcePath: entry.path,
    sourceSha256: entry.sha256,
    binding: { harness: 'pi', model: 'test/model', effort: 'medium' },
  };
  const options = { sourcePath: entry.path, diagnostics: [{ code: 'invalid_json', problem: 'Malformed JSON' }], consent };
  const response = (value = valid) => ({
    status: 'completed',
    sessionId: 'repair-session',
    freshSession: true,
    cost: { usd: 0.15, kind: 'estimate', cumulative: true, sessionId: 'repair-session' },
    text: JSON.stringify({ action: 'replace_state', sourceSha256: entry.sha256, value, explanation: 'Fixture proposal' }),
  });
  return { journal, entry, options, response };
}

test('one exact source and Pi binding must be consented before provider admission', async t => {
  const { journal, entry, options } = await fixture(t);
  let calls = 0; const run = async () => { calls++; };
  for (const consent of [null, { ...options.consent, accepted: false }, { ...options.consent, sourceSha256: '0'.repeat(64) },
    { ...options.consent, binding: { harness: 'claude', model: 'test', effort: 'medium' } }]) {
    await assert.rejects(requestStateRepair(journal, { ...options, consent, run }), /consent|Pi|binding/);
  }
  assert.equal(calls, 0);
  assert.equal(readFileSync(journal.sourcePath(entry), 'utf8'), '{broken');
});

test('proposal attempts and costs are durable; exact reviewed acceptance revalidates only staging', async t => {
  const { journal, entry, options, response } = await fixture(t);
  let calls = 0;
  const run = async request => {
    calls++;
    assert.equal(request.purpose, 'migration-repair');
    assert.equal(request.harness, 'pi');
    const input = JSON.parse(request.prompt);
    assert.equal(input.source.text, '{broken');
    assert.equal(input.source.sha256, entry.sha256);
    return response();
  };
  const proposed = await requestStateRepair(journal, { ...options, run });
  assert.equal(proposed.status, 'proposed');
  assert.equal(proposed.attempt.cost.usd, 0.15);
  const repeated = await requestStateRepair(journal, { ...options, run });
  assert.deepEqual(repeated, proposed);
  assert.equal(calls, 1);
  assert.throws(() => acceptStateRepair(journal, { sourcePath: entry.path, attemptId: proposed.attempt.id, proposalHash: 'wrong', confirmed: true, reviewedControl: true }), /approval|proposal/);
  const accepted = acceptStateRepair(journal, { sourcePath: entry.path, attemptId: proposed.attempt.id, proposalHash: proposed.proposalHash, confirmed: true, reviewedControl: true });
  assert.equal(accepted.status, 'accepted');
  assert.deepEqual(accepted.validation.errors, []);
  assert.deepEqual(accepted.override.value, valid);
  assert.equal(readFileSync(journal.sourcePath(entry), 'utf8'), '{broken');
  assert.equal(readFileSync(entry.path, 'utf8'), '{broken');
  assert.equal(journal.record.phase, 'staged');
});

test('an admitted repair interrupted before its receipt is never automatically or explicitly repeated', async t => {
  const { journal, options, response } = await fixture(t);
  let calls = 0;
  const run = async () => {
    calls++;
    return response();
  };
  await assert.rejects(requestStateRepair(journal, { ...options, run, failpoint: phase => { if (phase === 'admitted') throw Error('fixture crash'); } }), /fixture crash/);
  assert.equal(calls, 0);
  const recovered = await requestStateRepair(journal, { ...options, run });
  assert.equal(recovered.status, 'interrupted');
  assert.equal(recovered.attempt.cost, null);
  const retry = await requestStateRepair(journal, { ...options, run, retryOf: recovered.attempt.id });
  assert.equal(retry.status, 'interrupted');
  assert.equal(calls, 0);
});

test('completed invalid answers can be explicitly retried only within the persisted attempt budget', async t => {
  const { journal, options } = await fixture(t);
  let calls = 0;
  const run = async () => {
    calls++;
    return { status: 'completed', text: 'not JSON', cost: null };
  };
  const first = await requestStateRepair(journal, { ...options, run, maxAttempts: 2 });
  assert.equal(first.status, 'invalid_proposal');
  await requestStateRepair(journal, { ...options, run, maxAttempts: 2 });
  assert.equal(calls, 1);
  const second = await requestStateRepair(journal, { ...options, run, maxAttempts: 2, retryOf: first.attempt.id });
  assert.equal(calls, 2);
  await requestStateRepair(journal, { ...options, run, maxAttempts: 2, retryOf: second.attempt.id });
  assert.equal(calls, 2);
  await assert.rejects(requestStateRepair(journal, { ...options, run, maxAttempts: 3, retryOf: second.attempt.id }), /budget|scope/);
});

test('ownership errors and overlarge evidence cannot enter the repair provider', async t => {
  const small = await fixture(t), large = await fixture(t, 'x'.repeat(32769));
  let calls = 0; const run = async () => { calls++; };
  await assert.rejects(requestStateRepair(small.journal, { ...small.options, diagnostics: [{ code: 'ownership_scope', problem: 'Missing permission' }], run }), /not repairable|human/);
  await assert.rejects(requestStateRepair(large.journal, { ...large.options, run }), /bounded|large/);
  assert.equal(calls, 0);
});

test('normal import checks and protected stop state cannot be overridden by a model proposal', async t => {
  const { journal, entry, options, response } = await fixture(t, JSON.stringify({ ...valid, items: 'invalid' }));
  const proposed = await requestStateRepair(journal, { ...options, diagnostics: [{ code: 'invalid_state', problem: 'items must be an array' }], run: async () => response({ ...valid, started: true }) });
  assert.throws(() => acceptStateRepair(journal, { sourcePath: entry.path, attemptId: proposed.attempt.id, proposalHash: proposed.proposalHash, confirmed: true, reviewedControl: true }), /control|stop/);
  const malformed = await fixture(t);
  const bad = await requestStateRepair(malformed.journal, { ...malformed.options, run: async () => malformed.response({ version: 9 }) });
  const rejected = acceptStateRepair(malformed.journal, { sourcePath: malformed.entry.path, attemptId: bad.attempt.id, proposalHash: bad.proposalHash, confirmed: true, reviewedControl: true });
  assert.equal(rejected.status, 'invalid_proposal');
  assert.ok(rejected.validation.errors.length);
  assert.equal(malformed.journal.record.phase, 'staged');
});
