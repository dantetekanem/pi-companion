import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFileSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { migrationFixture } from './helpers/migration.mjs';
import { fakePi } from './helpers/pi-session.mjs';
import { runUpgrade } from '../src/cli/migration/cutover.mjs';
import { CompanionRuntime } from '../src/cli/runtime.mjs';
import { SessionDelivery } from '../src/cli/delivery.mjs';
import { UsageLedger } from '../src/cli/usage.mjs';
import { loadConfig } from '../src/cli/config.mjs';
import { loadImportedHistory } from '../src/cli/history.mjs';

async function fixture(t, { mappedCwd } = {}) {
  const h = await migrationFixture(t, {
    secondState: { version: 1, items: [], paused: [] },
    mutateTasks(_tasks, { selection, extra }) {
      for (const session of [selection, extra]) {
        if (mappedCwd !== undefined && session === extra) {
          const header = JSON.parse(readFileSync(session.sessionFile, 'utf8').trim());
          header.cwd = mappedCwd;
          writeFileSync(session.sessionFile, JSON.stringify(header) + '\n');
        }
        appendFileSync(session.sessionFile, [
          { type: 'model_change', id: 'model', parentId: null, timestamp: '2026-10-26T00:00:00Z', provider: 'fixture', modelId: 'local' },
          { type: 'thinking_level_change', id: 'effort', parentId: 'model', timestamp: '2026-10-26T00:00:00Z', thinkingLevel: 'medium' },
        ].map(value => JSON.stringify(value) + '\n').join(''));
      }
    },
  });
  await runUpgrade(h.journal, h.options);
  const config = loadConfig(h.root);
  const fake = fakePi(h.root);
  const runtime = await CompanionRuntime.open(h.root, config, { createMain: fake.createMain });
  await runtime.connect();
  const calls = [];
  const delivery = new SessionDelivery({ root: runtime.directory, runtime, config, runHarness: async input => {
    calls.push(input);
    return { status: 'completed', text: 'Ordinary<!-- companion-publication: fixture --> answer', sessionId: input.id, freshSession: true,
      model: input.model, effort: input.effort,
      cost: { usd: 0.25, sessionId: input.id, kind: 'estimate', cumulative: true } };
  } });
  t.after(async () => { await delivery.close(); await runtime.close(); });
  const request = index => ({ session: h.options.sessions[index], task: { id: `task_${index}` }, text: 'A scheduled check' });
  return { ...h, fake, config, runtime, delivery, request, calls };
}

function heldHarness(delivery) {
  const started = Promise.withResolvers();
  delivery.runHarness = async input => {
    started.resolve(input);
    await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }));
    return { status: 'interrupted', cost: null, sessionId: input.id, freshSession: true, model: input.model, effort: input.effort };
  };
  return started.promise;
}

test('each imported origin occurrence owns a fresh job, unchanged transcripts and distinct cost receipt', async t => {
  const h = await fixture(t);
  const imports = loadImportedHistory(h.root).sessions;
  const paths = [...imports.map(entry => entry.path), h.runtime.main.sessionFile];
  const before = paths.map(path => readFileSync(path));
  for (const origin of [0, 1, 0, 1]) {
    const id = `occurrence-${h.calls.length}`;
    const sessionId = h.request(origin).session.sessionId;
    await h.runtime.dispatch({ id, kind: 'background', harness: 'pi', harnessId: sessionId, sessionId, legacy: true },
      signal => h.delivery.prompt({ ...h.request(origin), signal }));
  }
  assert.equal(new Set(h.calls.map(call => call.id)).size, 4);
  for (const call of h.calls) {
    assert.match(call.id, /^[0-9a-f-]{36}$/);
    assert.equal(call.sessionFile, join(h.runtime.directory, 'jobs', `${call.id}.jsonl`));
    assert.equal(call.model, 'fixture/local');
    assert.equal(call.effort, 'medium');
    assert.equal(call.harness, 'pi');
    assert.equal(call.purpose, 'compatibility-check');
    assert.equal(call.prompt, 'A scheduled check');
    assert.equal(call.cwd, h.options.sessions[0].cwd);
  }
  assert.equal(statSync(join(h.runtime.directory, 'jobs')).mode & 0o777, 0o700);
  paths.forEach((path, index) => assert.deepEqual(readFileSync(path), before[index]));
  const state = await h.runtime.state();
  const runs = Object.values(state.runs);
  runs.forEach((run, index) => {
    assert.equal(run.result.text, 'Ordinary answer');
    assert.equal(run.result.sessionId, h.calls[index].id);
    assert.equal(run.result.freshSession, true);
    assert.equal(run.result.cost.sessionId, h.calls[index].id);
    assert.equal(run.harnessId, h.request(index % 2).session.sessionId);
  });
  assert.equal(UsageLedger.open(h.runtime.directory, h.config.initializedAt).sync(state).usd, 1);
});

test('delivery forwards only the provided activity observer to the fresh harness', async t => {
  const h = await fixture(t);
  const events = [];
  h.delivery.runHarness = async (_request, { onEvent }) => {
    onEvent({ type: 'tool_execution_start', toolName: 'read', toolCallId: 'one' });
    return { status: 'completed', text: 'Done' };
  };
  await h.delivery.prompt({ ...h.request(0), onEvent: event => events.push(event) });
  assert.equal(events[0].toolCallId, 'one');
});

test('origin-local reservations validate tokens and release idempotently', async t => {
  const h = await fixture(t);
  const id = h.request(0).session.sessionId;
  const token = h.delivery.reserve(id);
  assert.equal(h.delivery.ready(id), false);
  assert.equal(h.delivery.ready(h.request(1).session.sessionId), true);
  assert.equal(h.delivery.reserve(id), null);
  await assert.rejects(h.delivery.prompt({ ...h.request(0), reservation: { sessionId: id } }), /reservation/);
  await assert.rejects(h.delivery.prompt({ ...h.request(1), reservation: token }), /reservation/);
  await h.delivery.prompt({ ...h.request(0), reservation: token });
  assert.equal(h.delivery.ready(id), false);
  token.release();
  const newer = h.delivery.reserve(id);
  token.release();
  assert.equal(h.delivery.ready(id), false);
  newer.release();
  assert.equal(h.delivery.ready(id), true);
});

for (const order of ['scheduled-first', 'main-first']) {
  test(`main input and scheduled work proceed independently: ${order}`, async t => {
    const h = await fixture(t);
    const main = h.fake.controls.get(h.runtime.main.sessionId);
    main.gate = Promise.withResolvers();
    const started = heldHarness(h.delivery);
    let pending;
    if (order === 'main-first') await h.runtime.send('Direct input');
    pending = h.delivery.prompt(h.request(0));
    const child = await started;
    if (order === 'scheduled-first') await h.runtime.send('Direct input');
    assert.equal(h.runtime.mainBusy, true);
    await h.delivery.close();
    assert.equal((await pending).status, 'interrupted');
    assert.equal(child.signal.aborted, true);
    assert.equal(h.runtime.mainBusy, true);
    main.gate.resolve();
    await h.runtime.idle();
    assert.equal(main.calls, 1);
  });
}

for (const action of ['cancel', 'close']) {
  test(`${action} interrupts only the fresh child and preserves unknown cost`, async t => {
    const h = await fixture(t);
    const started = heldHarness(h.delivery);
    const controller = new AbortController();
    const pending = h.delivery.prompt({ ...h.request(0), signal: controller.signal });
    const child = await started;
    if (action === 'cancel') controller.abort();
    if (action === 'close') await h.delivery.close();
    const result = await pending;
    assert.equal(result.status, 'interrupted');
    assert.equal(result.sessionId, child.id);
    assert.equal(result.cost, null);
    assert.equal(child.signal.aborted, true);
    await h.runtime.send('Main still usable');
    await h.runtime.idle();
    assert.equal(h.fake.controls.get(h.runtime.main.sessionId).calls, 1);
  });
}

test('a scheduled check slower than an inherited saved timeout completes', async t => {
  const h = await fixture(t);
  h.delivery.config = { ...h.config, timeoutMs: 20 };
  h.delivery.runHarness = async input => {
    await new Promise(resolve => setTimeout(resolve, 100));
    return { status: input.signal.aborted ? 'interrupted' : 'completed', text: 'Slow answer' };
  };
  const result = await h.delivery.prompt(h.request(0));
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Slow answer');
});

test('false-trigger messages produce local reports; true-trigger messages run a fresh turn', async t => {
  const h = await fixture(t);
  const result = await h.delivery.message({ ...h.request(0), triggerTurn: false });
  assert.deepEqual(result, { status: 'completed', text: 'A scheduled check', noModel: true, cost: null });
  const modeled = await h.delivery.message(h.request(0));
  assert.equal(modeled.status, 'completed');
  assert.equal(modeled.sessionId, h.calls[0].id);
  assert.equal(h.calls.length, 1);
});

test('every turn revalidates binding and mapped cwd before provider dispatch', async t => {
  const h = await fixture(t);
  const id = h.request(0).session.sessionId;
  await h.delivery.prompt(h.request(0));
  h.delivery.config.legacySessions = { [id]: { model: 'fixture/updated', effort: 'high' } };
  await h.delivery.prompt(h.request(0));
  assert.equal(h.calls[1].model, 'fixture/updated');
  assert.equal(h.calls[1].effort, 'high');
  h.delivery.config.legacySessions[id].model = 'other/model';
  await assert.rejects(h.delivery.prompt(h.request(0)), /provider/);
  h.delivery.config.legacySessions[id].model = 'fixture/updated';
  h.delivery.config.legacySessions[id].harness = 'claude';
  await assert.rejects(h.delivery.prompt(h.request(0)), /harness must be pi/);
  delete h.delivery.config.legacySessions;
  assert.equal(h.calls.length, 2);
  for (const mappedCwd of ['/missing-companion-fixture-cwd']) {
    const invalid = await fixture(t, { mappedCwd });
    await assert.rejects(invalid.delivery.prompt(invalid.request(1)), /cwd|directory/i);
    assert.equal(invalid.calls.length, 0);
  }
  const indexPath = join(h.runtime.directory, 'imported/sessions/index.json');
  const index = JSON.parse(readFileSync(indexPath));
  delete index.sessions.find(entry => entry.sessionId === id).cwd;
  writeFileSync(indexPath, JSON.stringify(index));
  await assert.rejects(h.delivery.prompt(h.request(0)), /imported history changed/i);
  assert.equal(h.calls.length, 2);
});
