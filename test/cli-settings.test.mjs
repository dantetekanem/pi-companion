import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJson, initialize, loadConfig } from '../src/cli/config.mjs';
import { readSettings, updateSettings } from '../src/cli/settings.mjs';

const model = { provider: 'openai-codex', id: 'gpt-6-luna' };
function fixture(t, background = {}) {
  const root = mkdtempSync(join(tmpdir(), 'companion-settings-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = initialize(root, { cwd: root });
  config.main.model = 'openai-codex/old';
  config.background = { harness: 'pi', model: 'openai-codex/old', effort: 'low', ...background };
  atomicJson(join(root, 'config.json'), config);
  return root;
}
function schedule(root, id, patch = {}, body = 'Do the scheduled work.\n') {
  const path = join(root, 'schedules/daily', `${id}.md`);
  const data = { id, title: id, at: '09:00', timezone: 'UTC', enabled: false, harness: 'pi', effort: 'medium', cwd: root, context: [], ...patch };
  writeFileSync(path, `---\n${JSON.stringify(data, null, 2)}\n---\n${body}`);
  return path;
}
const modelRuntime = { getModel: (provider, id) => provider === model.provider && id === model.id ? model : undefined };
function activatedHome(t) {
  const home = fixture(t);
  const config = loadConfig(home);
  const id = '123e4567-e89b-42d3-a456-426614174000';
  const fingerprint = 'synthetic-fingerprint';
  const dataRoot = join(home, 'migration', id, 'data');
  for (const cadence of ['daily', 'weekly', 'monthly']) mkdirSync(join(dataRoot, 'schedules', cadence), { recursive: true, mode: 0o700 });
  atomicJson(join(dataRoot, 'config.json'), config);
  const schedulePath = schedule(dataRoot, 'migrated');
  const controlRoot = join(home, 'control');
  mkdirSync(controlRoot, { mode: 0o700 });
  const migration = { id, destination: home, fingerprint };
  const receipt = 'synthetic-shutdown-receipt';
  writeFileSync(join(controlRoot, 'fence.json'), JSON.stringify({ version: 1, ...migration }), { mode: 0o600 });
  const validation = { errors: [], ownership: { shutdownReceipt: receipt }, artifacts: [], legacyFence: { controlRoot, migration } };
  const validationId = createHash('sha256').update(JSON.stringify(validation)).digest('hex');
  const active = { version: 2, directory: `migration/${id}/data`, migrationId: id, fingerprint, validationId };
  const record = {
    version: 1, phase: 'verified', id, activation: active, manifest: { fingerprint },
    validation: { ...validation, id: validationId }, fence: { validationId, shutdownReceipt: receipt },
  };
  writeFileSync(join(home, 'active.json'), JSON.stringify(active), { mode: 0o600 });
  writeFileSync(join(home, 'migration', 'journal.json'), JSON.stringify(record), { mode: 0o600 });
  return { home, dataRoot, schedulePath };
}

test('updates all Pi conversation and schedule bindings without touching unrelated values', { concurrency: false }, async t => {
  const root = fixture(t);
  const path = schedule(root, 'paused', { model: 'openai-codex/schedule-model', effort: 'high', context: ['notes.md'] }, 'Keep this body.\n');
  let applied;
  const result = await updateSettings(root, { scope: 'all', model: 'openai-codex/gpt-6-luna', effort: 'xhigh' }, {
    modelRuntime,
    applyCurrent: value => { applied = value; return { model: 'openai-codex/gpt-6-luna', effort: 'xhigh' }; },
  });
  assert.equal(loadConfig(root).main.model, 'openai-codex/gpt-6-luna');
  const saved = readFileSync(path, 'utf8');
  assert.match(saved, /"effort": "xhigh"/);
  assert.match(saved, /"enabled": false/);
  assert.match(saved, /"context": \[\s+"notes.md"/);
  assert.ok(saved.endsWith('Keep this body.\n'));
  assert.deepEqual(applied, { model, effort: 'xhigh' });
  assert.deepEqual([result.persisted.settings.background.effort, result.persisted.settings.schedules[0].model], ['xhigh', 'openai-codex/gpt-6-luna']);
  assert.deepEqual(result.activeRuntime, { status: 'verified', effective: { model: 'openai-codex/gpt-6-luna', effort: 'xhigh' } });
});

test('rejects a model update crossing into a Claude target before changing any files', async t => {
  const root = fixture(t, { harness: 'claude', model: 'sonnet', effort: 'high' });
  const path = schedule(root, 'claude', { harness: 'claude', model: 'sonnet', effort: 'high' }); const before = [readFileSync(join(root, 'config.json'), 'utf8'), readFileSync(path, 'utf8')];
  let applied = false;
  const result = await updateSettings(root, { scope: 'all', model: 'openai-codex/gpt-6-luna' }, { modelRuntime, applyCurrent: () => { applied = true; } });
  assert.deepEqual([result.persisted.status, result.incompatibleScopes, result.activeRuntime.status, result.unchangedScopes], ['unchanged', ['background', 'schedules:claude'], 'unchanged', ['main']]);
  assert.deepEqual([readFileSync(join(root, 'config.json'), 'utf8'), readFileSync(path, 'utf8')], before);
});

test('reports persisted bindings separately when the active-session setter fails', async t => {
  const root = fixture(t);
  const result = await updateSettings(root, { scope: 'main', effort: 'high' }, {
    applyCurrent: () => { throw Error('setter failed'); },
  });
  assert.deepEqual([result.persisted.status, result.persisted.settings.main.effort], ['complete', 'high']);
  assert.deepEqual(result.activeRuntime, { status: 'unverified', error: 'setter failed' });
  assert.deepEqual(result.unchangedScopes, ['background', 'schedules']);
});

test('requires a fully qualified installed Pi model and leaves unrelated scopes unchanged', async t => {
  const root = fixture(t);
  const path = schedule(root, 'paused', { model: 'provider/custom' }); const before = [readFileSync(join(root, 'config.json'), 'utf8'), readFileSync(path, 'utf8')];
  await Promise.all([
    assert.rejects(updateSettings(root, { scope: 'main', model: 'gpt-6-luna' }, { modelRuntime }), /provider\/model/i),
    assert.rejects(updateSettings(root, { scope: 'main', model: 'openai-codex/missing' }, { modelRuntime }), /installed/i),
  ]);
  assert.deepEqual([readFileSync(join(root, 'config.json'), 'utf8'), readFileSync(path, 'utf8')], before);
  assert.equal(readSettings(root, 'background').background.model, 'openai-codex/old');
});

test('does not verify a requested active binding when the setter reports a different one', async t => {
  const root = fixture(t);
  const observed = { model: 'openai-codex/other', effort: 'medium' };
  const result = await updateSettings(root, { scope: 'main', model: 'openai-codex/gpt-6-luna', effort: 'high' }, {
    modelRuntime,
    applyCurrent: () => observed,
  });

  assert.deepEqual(result.activeRuntime, { status: 'unverified', effective: observed });
});

test('classifies a saved config followed by a failed native schedule write as partial persistence', async t => {
  const root = fixture(t);
  const path = schedule(root, 'paused', { model: 'openai-codex/old' });
  const directory = join(root, 'schedules', 'daily');
  chmodSync(directory, 0o500);
  let result;
  try {
    result = await updateSettings(root, { scope: 'all', model: 'openai-codex/gpt-6-luna', effort: 'high' }, { modelRuntime });
  } finally {
    chmodSync(directory, 0o700);
  }

  assert.equal(result.persisted.status, 'partial');
  assert.equal(result.persisted.settings.main.model, 'openai-codex/gpt-6-luna');
  assert.equal(result.persisted.failed.target, 'schedules:paused');
  assert.match(readFileSync(path, 'utf8'), /"model": "openai-codex\/old"/);
});

test('reads and writes model settings within a verified activated data root', async t => {
  const { home, dataRoot, schedulePath } = activatedHome(t);
  const beforeHomeConfig = readFileSync(join(home, 'config.json'), 'utf8');
  const result = await updateSettings(home, { scope: 'all', model: 'openai-codex/gpt-6-luna', effort: 'high' }, { modelRuntime });

  assert.equal(result.persisted.status, 'complete');
  assert.equal(loadConfig(dataRoot).main.model, 'openai-codex/gpt-6-luna');
  assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), beforeHomeConfig);
  assert.match(readFileSync(schedulePath, 'utf8'), /"model": "openai-codex\/gpt-6-luna"/);
  assert.equal(readSettings(home, 'all').schedules[0].model, 'openai-codex/gpt-6-luna');
});
