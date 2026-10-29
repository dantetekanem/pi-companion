import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SchedulerCompatibility } from '../src/cli/legacy-engine.mjs';
import { LegacySchedules } from '../src/cli/legacy-schedules.mjs';
import { CompanionRunner } from '../src/cli/runner.mjs';
import { CompanionRuntime } from '../src/cli/runtime.mjs';
import { loadSchedules } from '../src/cli/schedules.mjs';
import { sha256 } from '../src/cli/migration/inventory.mjs';

const packageDirectory = process.env.COMPANION_TEST_SCHEDULER;
const realEngine = { skip: packageDirectory ? false : 'Set COMPANION_TEST_SCHEDULER to an existing pi-scheduler 0.5.1 installation.' };
const time = '2026-03-08T16:00:00.000Z';
const rawTask = (overrides = {}) => ({
  id: 'task_fixture',
  action: 'prompt',
  type: 'interval',
  schedule: '24h',
  intervalMs: 86400000,
  prompt: 'Check',
  scope: 'session',
  sessionFile: '/synthetic/origin.jsonl',
  createdAt: '2026-03-06T17:00:00.000Z',
  dueAt: '2026-03-07T17:00:00.000Z',
  nextRun: '2026-03-07T17:00:00.000Z',
  enabled: true,
  status: 'pending',
  runCount: 2,
  ...overrides,
});
const wrapper = (task, compatibility) => ({
  version: 1,
  id: 'legacy-fixture',
  origin: 'session:fixture',
  role: 'routine',
  timezone: 'America/New_York',
  session: { sessionFile: task.sessionFile, sessionId: 'fixture', cwd: '/synthetic' },
  source: { taskId: task.id, sha256: sha256(JSON.stringify(task)) },
  control: { started: true, experienceEnabled: true },
  compatibility,
  legacy: task,
});

test('real pinned scheduler keeps completion-based 24h intervals and backoff across DST', realEngine, async () => {
  const engine = SchedulerCompatibility.open(packageDirectory);
  const task = rawTask({ backoff: { factor: 2, maxIntervalMs: 172800000, currentIntervalMs: 86400000 } });
  const binding = await engine.validate(task, 'America/New_York');
  assert.equal(binding.version, '0.5.1');
  const prepared = await engine.request(binding, 'prepare', { task, now: time, notBefore: '2026-03-06T00:00:00Z' });
  assert.equal(prepared.dueAt, task.nextRun);
  const completedAt = '2026-03-08T16:05:00.000Z';
  const finished = await engine.request(binding, 'complete', { task, now: completedAt, startedAt: time, attemptId: 'fixture-attempt', result: {}, ok: true });
  assert.equal(finished.nextRun, '2026-03-10T16:05:00.000Z');
  assert.equal(finished.runCount, 3);
  assert.equal(finished.backoff.currentIntervalMs, 172800000);
  assert.equal(finished.history[0].attemptId, 'fixture-attempt');
});

test('real cron timezone, cutover boundary, missed once and stopped state are preserved explicitly', realEngine, async () => {
  const engine = SchedulerCompatibility.open(packageDirectory);
  const task = rawTask({ type: 'cron', schedule: '0 9 1,15 * *', dueAt: '2026-03-01T14:00:00.000Z', nextRun: '2026-03-01T14:00:00.000Z' });
  const binding = await engine.validate(task, 'America/New_York');
  const prepared = await engine.request(binding, 'prepare', { task, now: '2026-03-15T13:00:00.000Z', notBefore: time });
  assert.equal(prepared.dueAt, '2026-03-15T13:00:00.000Z');
  const interval = await engine.request(binding, 'prepare', { task: rawTask(), now: time, notBefore: time });
  assert.equal(interval.task.nextRun, '2026-03-08T17:00:00.000Z');
  assert.equal(interval.dueAt, null);
  const once = rawTask({ type: 'once', schedule: '2026-03-07T17:00:00Z' });
  const past = await engine.request(binding, 'prepare', { task: once, now: time, notBefore: time });
  assert.equal(past.task.status, 'expired');
  assert.equal(past.dueAt, null);
  const disabled = await engine.request(binding, 'prepare', { task: { ...task, enabled: false }, now: time, notBefore: time });
  assert.equal(disabled.task.enabled, false);
  assert.equal(disabled.dueAt, null);
});

test('compatibility framing preserves large Unicode instruction fields exactly', realEngine, async () => {
  const engine = SchedulerCompatibility.open(packageDirectory), task = rawTask({ enabled: false, prompt: '🧭é日本語'.repeat(10000) });
  const binding = await engine.validate(task, 'UTC');
  const prepared = await engine.request(binding, 'prepare', { task, now: time, notBefore: time });
  assert.equal(sha256(prepared.task.prompt), sha256(task.prompt));
});

test('engine rejects a changed binding before evaluating code', realEngine, async () => {
  const engine = SchedulerCompatibility.open(packageDirectory), task = rawTask();
  const binding = await engine.validate(task, 'UTC');
  binding.pins[0].sha256 = '0'.repeat(64);
  await assert.rejects(engine.request(binding, 'prepare', { task, now: time, notBefore: time }), /pin|identity|changed/);
});

test('legacy action adapter routes the four actions and daily review without treating token text as a user prompt', realEngine, async () => {
  const engine = SchedulerCompatibility.open(packageDirectory);
  const calls = [];
  const handlers = Object.fromEntries(['prompt', 'message', 'notify', 'dailyReview'].map(kind => [kind, async input => {
    calls.push({ kind, input });
    return { status: 'completed', text: kind, cost: null };
  }]));
  handlers.shell = async input => {
    calls.push({ kind: 'shell', input });
    return { stdout: 'fixture', stderr: '', code: 0, killed: false };
  };
  const adapter = new LegacySchedules({ engine, handlers, now: () => new Date(time) });
  const onEvent = () => {};
  for (const action of ['prompt', 'notify', 'message', 'shell']) {
    const task = rawTask({ action, message: 'Message', command: 'fixture-only', triggerTurn: false, wakeOn: 'success', stopOn: 'success', followUpPrompt: 'Summarize result' });
    const value = wrapper(task, await engine.validate(task, 'America/New_York'));
    const result = await adapter.execute(value, { task, occurrence: { id: action, scheduledAt: time } }, new AbortController().signal, null, { onEvent });
    assert.equal(calls.at(-1).input.onEvent, onEvent);
    assert.equal(result.status, 'completed');
    assert.equal(result.compatibilityTask.runCount, task.runCount + 1);
    if (action === 'shell') assert.equal(result.compatibilityTask.enabled, false);
  }
  assert.deepEqual(calls.map(call => call.kind), ['prompt', 'notify', 'message', 'shell', 'prompt']);
  assert.equal(calls[2].input.triggerTurn, false);
  const wake = rawTask({ prompt: 'companion-daily:token' });
  const value = { ...wrapper(wake, await engine.validate(wake, 'America/New_York')), role: 'daily-wake' };
  await adapter.execute(value, { task: wake, occurrence: { id: 'wake', scheduledAt: time } }, new AbortController().signal);
  assert.equal(calls.at(-1).kind, 'dailyReview');
});

test('real shell wake-on-change fingerprint and once completion use upstream semantics', realEngine, async () => {
  const engine = SchedulerCompatibility.open(packageDirectory);
  const task = rawTask({ action: 'shell', type: 'once', schedule: '2026-03-07T17:00:00Z', command: 'fixture-only', cwd: '/synthetic', wakeOn: 'change', followUpPrompt: 'Review' });
  const binding = await engine.validate(task, 'UTC');
  const first = await engine.request(binding, 'shell-wake', { task, result: { stdout: 'a', stderr: '', code: 0 } });
  assert.equal(first.wake, false);
  const unchanged = await engine.request(binding, 'shell-wake', { task: first.task, result: { stdout: 'a', stderr: '', code: 0 } });
  assert.equal(unchanged.wake, false);
  const changed = await engine.request(binding, 'shell-wake', { task: unchanged.task, result: { stdout: 'b', stderr: '', code: 0 } });
  assert.equal(changed.wake, true);
  const finished = await engine.request(binding, 'complete', { task: changed.task, now: time, startedAt: time, attemptId: 'once', result: {}, ok: true });
  assert.equal(finished.status, 'fired');
  assert.equal(finished.enabled, false);
});

test('runner admits compatibility work once, retains completion state and blocks uncertain replay after reopening', realEngine, async t => {
  const root = mkdtempSync(join(tmpdir(), 'companion-legacy-runner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const engine = SchedulerCompatibility.open(packageDirectory), task = rawTask();
  const value = wrapper(task, await engine.validate(task, 'America/New_York'));
  const directory = join(root, 'schedules/compatibility');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'fixture.json'), JSON.stringify(value));
  assert.equal(loadSchedules(root).counts.compatibility, 1);
  let calls = 0;
  const config = { initializedAt: '2026-03-06T00:00:00Z', concurrency: 2, timeoutMs: 1000 };
  const runtime = await CompanionRuntime.open(root, config);
  const adapter = new LegacySchedules({
    engine,
    handlers: {
      prompt: async () => {
        calls++;
        return { status: 'completed', text: 'Finished', cost: null };
      },
    },
    now: () => new Date(time),
  });
  const runner = new CompanionRunner({ runtime, root, config, compatibility: adapter, now: () => new Date(time) });
  await runner.tick();
  await runtime.idle();
  await runner.tick();
  assert.equal(calls, 1);
  assert.equal((await runner.snapshot()).reports.length, 1);
  await runner.stop();
  await runtime.close();
  const reopened = await CompanionRuntime.open(root, config);
  const next = new CompanionRunner({ runtime: reopened, root, config, compatibility: adapter, now: () => new Date(time) });
  await next.tick();
  await reopened.idle();
  assert.equal(calls, 1);
  await next.stop();
  await reopened.close();
  const interrupted = await CompanionRuntime.open(root, config);
  await interrupted.admit({ id: 'uncertain', kind: 'background', scheduleId: value.id, scheduledAt: '2026-03-09T16:00:00Z', title: 'Legacy' });
  await interrupted.close();
  const recovered = await CompanionRuntime.open(root, config);
  const recovery = new CompanionRunner({ runtime: recovered, root, config, compatibility: adapter, now: () => new Date('2026-03-10T16:00:00Z') });
  await recovery.tick();
  await recovered.idle();
  assert.equal(calls, 1);
  assert.ok((await recovery.snapshot()).errors.some(error => /interrupted|uncertain/.test(error.message)));
  await recovery.stop();
  await recovered.close();
});
