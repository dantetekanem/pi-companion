import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanionApplication } from '../src/cli/application.mjs';
import { atomicJson, initialize } from '../src/cli/config.mjs';
import { openPiSession } from '../src/cli/pi-session.mjs';
import { dialog, fakePiRpc } from './helpers/fake-rpc-pi.mjs';
import { fakePi } from './helpers/pi-session.mjs';

const launcher = { command: ['my-pi-launcher', 'pi'], env: { EXAMPLE_MODE: '1' }, managedExtensions: true };

function fixture(t, withLauncher) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'companion-launcher-app-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = initialize(root, { cwd: root, now: '2026-01-01T00:00:00Z' });
  config.main = { cwd: root, model: 'fixture/local', effort: 'medium' };
  if (withLauncher) config.launcher = launcher;
  atomicJson(join(root, 'config.json'), config);
  const schedule = {
    id: 'email', title: 'Email follow-up', enabled: false, window: { start: '09:00', end: '10:00', everyMinutes: 60 },
    timezone: 'UTC', cwd: root, harness: 'pi', model: 'fixture/local', effort: 'high', context: [],
  };
  writeFileSync(join(root, 'schedules/daily/email.md'), `---\n${JSON.stringify(schedule)}\n---\nCheck fixture only.\n`);
  const requests = [];
  const runHarness = async request => {
    requests.push(request);
    return { status: 'completed', text: 'Nothing new', sessionId: request.id, freshSession: true, cost: null };
  };
  return { root, requests, runHarness };
}

test('with a launcher the main chat is an RPC child and a schedule it starts runs its job through the same launcher', async t => {
  const h = fixture(t, true);
  const pi = fakePiRpc();
  const app = await CompanionApplication.open(h.root, {
    now: () => new Date('2026-04-27T23:00:00Z'),
    intervalMs: 60000,
    runHarness: h.runHarness,
    createMain: options => openPiSession(options, { spawnProcess: pi.spawnProcess, graceMs: 50 }),
  });
  t.after(() => app.close());
  assert.equal(pi.spawned.length, 1);
  assert.equal(pi.spawned[0].command, 'my-pi-launcher');
  assert.deepEqual(app.snapshot.main, { harness: 'pi', model: 'fixture/local', effort: 'medium' });

  const id = dialog(pi.children[0], {
    method: 'input',
    title: 'companion/bridge',
    placeholder: JSON.stringify({ op: 'tool', name: 'run_schedule', id: 'call-1', params: { scheduleId: 'email' } }),
  });
  while (!pi.received.some(record => record.id === id)) await new Promise(resolve => setImmediate(resolve));
  const answer = JSON.parse(pi.received.find(record => record.id === id).value);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.details.status, 'running');
  await app.runtime.idle();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.requests[0].launcher, launcher);
  assert.equal(h.requests[0].harness, 'pi');
  assert.equal(h.requests[0].model, 'fixture/local');
  assert.equal(h.requests[0].effort, 'high');

  pi.children[0].exit(3, 'my-pi-launcher: session ended');
  while (!app.runtime.mainFault) await new Promise(resolve => setImmediate(resolve));
  await app.refresh();
  assert.match(app.snapshot.error, /^Main chat stopped: .*session ended.*scheduled checks keep running/);
  assert.equal(app.snapshot.connection, 'connected');
  assert.equal((await app.runner.trigger('email', 'request-2')).status, 'running');
  await app.runtime.idle();
  assert.equal(h.requests.length, 2, 'a schedule still runs after the chat stopped');
});

test('without a launcher the main chat stays in process and job requests are exactly as before', async t => {
  const h = fixture(t, false);
  const fake = fakePi(h.root);
  const app = await CompanionApplication.open(h.root, {
    now: () => new Date('2026-04-27T23:00:00Z'),
    intervalMs: 60000,
    runHarness: h.runHarness,
    createMain: fake.createMain,
  });
  t.after(() => app.close());
  assert.equal(fake.opened.length, 1, 'the SDK session opened in this process');
  assert.equal((await app.runner.trigger('email', 'request-1')).status, 'running');
  await app.runtime.idle();
  assert.equal(h.requests.length, 1);
  assert.equal('launcher' in h.requests[0], false);
});
