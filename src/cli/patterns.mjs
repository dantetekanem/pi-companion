import { lstatSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { collectSessionPatterns } from './session-patterns.mjs';
import { validateBinding } from './schedules.mjs';
import { atomicJson, loadConfig } from './config.mjs';
import { assertRuntimeAdmission } from './migration/admission.mjs';
import { CompanionRuntime } from './runtime.mjs';
import { runHarness } from './harnesses.mjs';
import { UsageLedger } from './usage.mjs';
import { readLocalView } from './view.mjs';
import { reportText } from './reports.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function readSelection(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > 131072) throw Error('Selection must be a bounded regular JSON file.');
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw Error('Invalid selection JSON.');
  }
}

function collect(selection) {
  const binding = selection.consent;
  if (!binding) throw Error('Explicit destination consent is required.');
  validateBinding(binding);
  if (!binding.model || (binding.harness === 'pi' && !/^[^/\s]+\/\S+$/.test(binding.model))) {
    throw Error('Review consent requires an exact model binding.');
  }
  const evidence = collectSessionPatterns(selection);
  if (!evidence.requests.length) throw Error('No user-role evidence in this selection; nothing to submit.');
  const payload = { selection, binding, evidence };
  if (Buffer.byteLength(JSON.stringify(payload)) > 65536) throw Error('Preview exceeds the review envelope. Narrow the selection.');
  return { version: 1, hash: digest(payload), ...payload };
}

export function previewPatterns(root, selection) {
  root = assertRuntimeAdmission(root);
  loadConfig(root);
  const preview = collect(selection);
  atomicJson(join(root, 'reviews', `${preview.hash}.json`), preview);
  return preview;
}

export async function submitPatterns(root, { hash, confirmation, run = runHarness, signal } = {}) {
  if (!/^[a-f0-9]{64}$/.test(hash ?? '') || hash !== confirmation) throw Error('Confirm the exact preview hash before submitting.');
  root = assertRuntimeAdmission(root);
  const preview = readSelection(join(root, 'reviews', `${hash}.json`));
  if (preview.hash !== hash || collect(preview.selection).hash !== hash
    || digest({ selection: preview.selection, binding: preview.binding, evidence: preview.evidence }) !== hash) {
    throw Error('The preview, destination or selected sources changed. Preview again.');
  }
  const config = loadConfig(root);
  const runtime = await CompanionRuntime.open(root, config);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const id = `patterns:${hash}`;
    const jobId = randomUUID();
    const directory = join(root, 'jobs');
    const receipt = await runtime.dispatch({ id, kind: 'background', title: 'Session-pattern proposals', ...preview.binding }, async dispatchSignal => {
      const combined = AbortSignal.any([dispatchSignal, controller.signal, ...(signal ? [signal] : [])]);
      combined.throwIfAborted();
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const result = await run({
        ...preview.binding,
        id: jobId,
        purpose: 'session-patterns',
        cwd: root,
        sessionFile: join(directory, `${jobId}.jsonl`),
        prompt: JSON.stringify({
          scope: {
            from: preview.selection.from,
            to: preview.selection.to,
            destination: preview.binding,
            exclusions: {
              files: preview.selection.excludeFiles?.length ?? 0,
              textRules: preview.selection.excludeText?.length ?? 0,
            },
          },
          evidence: preview.evidence,
        }),
        signal: combined,
      });
      return {
        ...result,
        text: reportText(result.text).slice(0, 32768),
        coverage: preview.evidence.coverage,
        omissions: preview.evidence.omissions,
      };
    });
    const state = await runtime.state();
    UsageLedger.open(root, config.initializedAt).sync(state);
    const view = readLocalView(root);
    const report = {
      id,
      title: 'Session-pattern proposals',
      at: receipt.finishedAt,
      outcome: receipt.status,
      body: `${reportText(receipt.result?.text || receipt.result?.error || receipt.error || 'Review did not complete.')}\n\nCoverage: ${JSON.stringify(preview.evidence.coverage)}\nOmissions: ${JSON.stringify(preview.evidence.omissions)}`.slice(0, 32768),
    };
    atomicJson(join(root, 'runtime/view.json'), {
      version: 1,
      savedAt: new Date().toISOString(),
      messages: view.messages,
      runs: view.runs,
      reports: [report, ...view.reports.filter(item => item.id !== id && item.id !== 'patterns-offer')].slice(0, 200),
    });
    return receipt;
  } finally {
    signal?.removeEventListener('abort', cancel);
    await runtime.close();
  }
}
