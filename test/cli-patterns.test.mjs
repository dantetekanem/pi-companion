import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { initialize } from '../src/cli/config.mjs';
import { previewPatterns, submitPatterns } from '../src/cli/patterns.mjs';
import { readLocalView } from '../src/cli/view.mjs';
import { buildInvocation } from '../src/cli/harnesses.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'companion-patterns-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { cwd: root });
  const source = join(root, 'selected.jsonl');
  writeFileSync(source, JSON.stringify({
    type: 'message',
    id: 'one',
    timestamp: '2026-01-02T09:00:00Z',
    message: { role: 'user', content: 'Review my recurring work' },
  }) + '\n');
  return {
    root,
    source,
    selection: {
      sources: [{ path: source, harness: 'pi' }],
      from: '2026-01-01',
      to: '2026-01-03',
      consent: { harness: 'pi', model: 'fixture/reviewer', effort: 'high' },
    },
  };
}

test('preview never submits; exact confirmation submits only the pinned bounded evidence once and accounts it', async t => {
  const h = fixture(t);
  h.selection.excludeText = ['private exclusion value'];
  const preview = previewPatterns(h.root, h.selection);
  assert.equal(preview.evidence.requests.length, 1);
  assert.equal(preview.binding.model, 'fixture/reviewer');
  let calls = 0;
  const run = async request => {
    calls++;
    assert.equal(request.purpose, 'session-patterns');
    assert.deepEqual(JSON.parse(request.prompt).evidence, preview.evidence);
    assert.equal(request.prompt.includes('private exclusion value'), false);
    return {
      status: 'completed',
      text: 'Weekly proposal with evidence.',
      sessionId: request.id,
      freshSession: true,
      cost: { usd: 0.2, sessionId: request.id, kind: 'estimate', cumulative: true },
    };
  };
  await assert.rejects(submitPatterns(h.root, { hash: preview.hash, confirmation: 'wrong', run }), /confirm/i);
  assert.equal(calls, 0);
  const result = await submitPatterns(h.root, { hash: preview.hash, confirmation: preview.hash, run });
  assert.equal(result.status, 'completed');
  assert.equal(calls, 1);
  assert.equal((await submitPatterns(h.root, { hash: preview.hash, confirmation: preview.hash, run })).id, result.id);
  assert.equal(calls, 1);
  const view = readLocalView(h.root);
  assert.equal(view.usage.usd, 0.2);
  assert.ok(view.reports.some(report => report.body.includes('Weekly proposal')));
});

test('changed sources, changed destination or absent consent cannot enter review', async t => {
  const h = fixture(t);
  let calls = 0;
  assert.throws(() => previewPatterns(h.root, { ...h.selection, consent: undefined }), /consent|binding/i);
  const preview = previewPatterns(h.root, h.selection);
  writeFileSync(join(h.root, 'reviews', `${preview.hash}.json`), JSON.stringify({ ...preview, binding: { ...preview.binding, model: 'other/reviewer' } }));
  await assert.rejects(submitPatterns(h.root, { hash: preview.hash, confirmation: preview.hash, run: () => { calls++; } }), /changed|preview/i);
  previewPatterns(h.root, h.selection);
  appendFileSync(h.source, '\n');
  await assert.rejects(submitPatterns(h.root, { hash: preview.hash, confirmation: preview.hash, run: () => { calls++; } }), /changed|preview/i);
  assert.equal(calls, 0);
});

test('Claude destinations reject fresh and saved previews before submission without rewriting them', async t => {
  const h = fixture(t);
  const selection = { ...h.selection, consent: { harness: 'claude', model: 'sonnet', effort: 'high' } };
  assert.throws(() => previewPatterns(h.root, selection), /harness.*pi/);
  const preview = previewPatterns(h.root, h.selection);
  const payload = { selection, binding: selection.consent, evidence: { ...preview.evidence, destination: { harness: 'claude', model: 'sonnet' } } };
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const path = join(h.root, 'reviews', `${hash}.json`);
  const saved = JSON.stringify({ version: 1, hash, ...payload });
  writeFileSync(path, saved);
  let calls = 0;
  await assert.rejects(submitPatterns(h.root, { hash, confirmation: hash, run: () => { calls++; } }), /harness.*pi/);
  assert.equal(calls, 0);
  assert.equal(readFileSync(path, 'utf8'), saved);
});

test('Pi pattern review disables tools', () => {
  const invocation = buildInvocation({
    harness: 'pi',
    model: 'fixture/reviewer',
    effort: 'high',
    id: 'ccb12430-4c74-49a1-bfa4-72d14c9bd898',
    cwd: '/synthetic',
    sessionFile: '/synthetic/job.jsonl',
    prompt: '{}',
    purpose: 'session-patterns',
  });
  assert.ok(invocation.args.includes('--no-tools'));
});
