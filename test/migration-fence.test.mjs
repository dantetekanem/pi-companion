import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { LegacyOwner, installLegacyFence, legacyIsFenced, collectShutdownReceipt } from '../src/cli/migration/fence.mjs';

const packageRoot = resolve(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')), '../..');
const require = createRequire(join(packageRoot, 'package.json')), { createJiti } = require('jiti');
const host = createJiti(join(packageRoot, 'package.json'));
const alias = Object.fromEntries(['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', '@earendil-works/pi-ai', 'typebox/value', 'typebox'].map(name => [name, fileURLToPath(host.esmResolve(name))]));
const { registerCompanion } = await createJiti(import.meta.url, { moduleCache: false, alias }).import('../src/index.ts');
const identity = { sessionId: 'synthetic-owner', sessionFile: '/synthetic/owner.jsonl' };
const migration = { id: 'migration-fixture', fingerprint: 'f'.repeat(64), destination: '/synthetic/new-home', owners: [identity] };
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'companion-fence-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'legacy'), controlRoot = join(directory, 'control');
  mkdirSync(root);
  return { root, controlRoot };
}

test('a fence blocks new owners and a running owner cannot masquerade as a shutdown receipt', async t => {
  const { root, controlRoot } = fixture(t);
  const owner = await LegacyOwner.open(root, identity, { controlRoot });
  t.after(() => owner.close(async () => {}));
  assert.equal(legacyIsFenced(root, controlRoot), false);
  await installLegacyFence(root, migration, { controlRoot });
  assert.equal(legacyIsFenced(root, controlRoot), true);
  await assert.rejects(LegacyOwner.open(root, { ...identity, sessionId: 'new-owner' }, { controlRoot }), /fenced/);
  await assert.rejects(collectShutdownReceipt(root, migration, { controlRoot }), /running|shutdown/);
  let drained = false;
  await owner.close(async () => { drained = true; });
  assert.equal(drained, true);
  const receipt = await collectShutdownReceipt(root, migration, { controlRoot });
  assert.equal(receipt.kind, 'host-shutdown');
  assert.equal(receipt.sessions[0].state, 'stopped');
  assert.equal(receipt.sessions[0].basis, 'extension-shutdown');
  assert.equal((await collectShutdownReceipt(root, migration, { controlRoot })).receiptId, receipt.receiptId);
});

test('pre-protocol owners require exact explicit offline confirmation, never a pane hint', async t => {
  const { root, controlRoot } = fixture(t);
  await installLegacyFence(root, migration, { controlRoot });
  await assert.rejects(collectShutdownReceipt(root, migration, { controlRoot, offline: { pane: 'w1:p24' } }), /offline|unproven/);
  const offline = { confirmed: true, migrationId: migration.id, fingerprint: migration.fingerprint, sessions: [identity], confirmedAt: '2026-10-26T00:00:00Z' };
  const receipt = await collectShutdownReceipt(root, migration, { controlRoot, offline });
  assert.equal(receipt.sessions[0].basis, 'operator-attested-offline');
  assert.equal(receipt.attested, true);
  await assert.rejects(collectShutdownReceipt(root, migration, { controlRoot, offline: { ...offline, fingerprint: 'changed' } }), /offline|scope/);
  await assert.rejects(installLegacyFence(root, { ...migration, id: 'other' }, { controlRoot }), /different|conflict/);
});

test('failed draining leaves an unproven owner instead of issuing a successful receipt', async t => {
  const { root, controlRoot } = fixture(t);
  const owner = await LegacyOwner.open(root, identity, { controlRoot });
  await installLegacyFence(root, migration, { controlRoot });
  await assert.rejects(owner.close(async () => { throw Error('drain failed'); }), /drain failed/);
  await assert.rejects(collectShutdownReceipt(root, migration, { controlRoot }), /unproven|shutdown/);
});

for (const started of [false, true]) test(`fenced extension hooks reject mutations, including an owner already started: ${started}`, async t => {
  const { root, controlRoot } = fixture(t);
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const sent = [];
  const pi = {
    on(name, handler) {
      const entries = handlers.get(name) ?? [];
      entries.push(handler);
      handlers.set(name, entries);
    },
    registerCommand(name, command) { commands.set(name, command); },
    registerTool(tool) { tools.set(tool.name, tool); },
    sendUserMessage(message) { sent.push(message); },
    getCommands() { return []; },
  };
  const paths = { root, migrationControlRoot: controlRoot, schedulerFile: join(root, 'tasks.json'), schedulesFile: join(root, 'registry.md'), reportsFile: join(root, 'reports.md'), reviewSettingsFile: join(root, 'settings.json') };
  writeFileSync(paths.schedulesFile, '## Routine\n');
  writeFileSync(paths.schedulerFile, '[]');
  const ctx = { hasUI: false, model: { provider: 'test' }, isIdle: () => true,
    sessionManager: { getSessionId: () => identity.sessionId, getSessionFile: () => identity.sessionFile, getLeafId: () => 'leaf' } };
  registerCompanion(pi, paths);
  const emit = async (name, event = {}) => {
    const results = [];
    for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
    return results;
  };
  if (started) await emit('session_start');
  await installLegacyFence(root, migration, { controlRoot });
  if (started) await assert.rejects(collectShutdownReceipt(root, migration, { controlRoot }), /running/);
  else await emit('session_start');
  await emit('input', { source: 'interactive', text: 'An ordinary message' });
  await emit('agent_settled');
  await emit('tool_result', { toolName: 'schedule_task', details: {}, isError: false });
  await commands.get('companion').handler('start', ctx);
  await assert.rejects(tools.get('companion_record').execute('call', { kind: 'observation', id: 'record', text: 'No write', evidenceIds: [] }, null, null, ctx), /fenced/);
  const blocked = await emit('tool_call', { toolName: 'schedule_task', input: { name: 'Routine', action: 'prompt' } });
  assert.ok(blocked.some(value => value?.block));
  assert.deepEqual(sent, []);
  assert.equal(existsSync(join(root, 'durable/companion.sqlite')), false);
  assert.equal(existsSync(paths.reportsFile), false);
  assert.equal(readFileSync(paths.schedulerFile, 'utf8'), '[]');
  await emit('session_shutdown');
  if (started) assert.equal((await collectShutdownReceipt(root, migration, { controlRoot })).sessions[0].basis, 'extension-shutdown');
});
