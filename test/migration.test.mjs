import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { migrationFixture } from './helpers/migration.mjs';
import { runUpgrade } from '../src/cli/migration/cutover.mjs';
import { scheduleSignature } from '../src/cli/migration/schedules.mjs';
import { sha256 } from '../src/cli/migration/inventory.mjs';
import { LegacyOwner, legacyIsFenced } from '../src/cli/migration/fence.mjs';
import { SchedulerCompatibility } from '../src/cli/legacy-engine.mjs';
import { LegacySchedules } from '../src/cli/legacy-schedules.mjs';
import { CompanionRuntime } from '../src/cli/runtime.mjs';
import { CompanionRunner } from '../src/cli/runner.mjs';
import { loadConfig } from '../src/cli/config.mjs';
import { loadSchedules } from '../src/cli/schedules.mjs';
import { loadImportedHistory } from '../src/cli/history.mjs';

const packageDirectory = process.env.COMPANION_TEST_SCHEDULER;
const realEngine = { skip: packageDirectory ? false : 'Set COMPANION_TEST_SCHEDULER to installed pi-scheduler 0.5.1.' };

test('real-engine upgrade preserves mixed origins/actions/stops and fences the old owner before one-time execution', realEngine, async t => {
  // Future even minute keeps this fixture independent of the actual migration creation time.
  const due = new Date(Math.ceil((Date.now() + 120000) / 120000) * 120000).toISOString();
  const h = await migrationFixture(t, {
    secondState: { version: 1, items: [], paused: [], started: false },
    mutateTasks(tasks, { state, extra }) {
      for (const task of tasks.slice(0, 3)) Object.assign(task, { nextRun: due, dueAt: due });
      state.paused.push({ id: tasks[1].id, signature: scheduleSignature(tasks[1]), disabledAt: tasks[1].disabledAt });
      const add = (id, patch) => tasks.push({ ...tasks[0], id, ...patch });
      add('task_notify', { type: 'once', schedule: due, action: 'notify', message: 'A local notice' });
      add('task_message', { type: 'cron', schedule: '*/2 * * * *', action: 'message', message: 'A local message', triggerTurn: false });
      add('task_shell', {
        action: 'shell',
        command: 'fixture-only-never-executed',
        wakeOn: 'success',
        stopOn: 'success',
        followUpPrompt: 'Review fixture result',
        backoff: { factor: 2, currentIntervalMs: 86400000, maxIntervalMs: 172800000 },
      });
      add('task_stopped_origin', { sessionFile: extra.sessionFile });
    },
  });
  const engine = SchedulerCompatibility.open(packageDirectory);
  h.options.engine = engine;
  h.options.decisions.forEach(decision => { decision.timezone = 'America/New_York'; });
  const legacyRoot = join(h.home, '.pi/agent/companion');
  const owner = await LegacyOwner.open(legacyRoot, h.journal.record.selection, { controlRoot: h.options.controlRoot });
  t.after(() => owner.close(async () => {}));
  await assert.rejects(runUpgrade(h.journal, h.options), /owner|active|running/i);
  assert.equal(owner.active, true); // The fence blocks admission; it does not pretend to stop a process.
  assert.equal(legacyIsFenced(legacyRoot, h.options.controlRoot), true);
  await assert.rejects(CompanionRuntime.open(h.root, h.options.config), /incomplete|verified/i);
  await owner.close(async () => {});
  const result = await runUpgrade(h.journal, h.options), root = result.root;
  assert.equal(result.status, 'verified');
  assert.equal(result.scheduleCount, 7);
  await assert.rejects(LegacyOwner.open(legacyRoot, h.journal.record.selection, { controlRoot: h.options.controlRoot }), /fenced/);
  assert.deepEqual(h.journal.record.validation.scheduleIds.sort(), h.journal.record.validation.validatedScheduleIds.sort());
  const scheduler = JSON.parse(readFileSync(h.schedulerFile, 'utf8'));
  assert.equal(scheduler.revision, 5);
  assert.equal(scheduler.unknown, 'preserve');
  assert.deepEqual(scheduler.tasks.find(task => task.id === 'task_other'), h.tasks.find(task => task.id === 'task_other'));
  assert.ok(scheduler.tasks.filter(task => task.id !== 'task_other').every(task => !task.enabled));
  const loaded = loadSchedules(root);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.counts.compatibility, 7);
  assert.equal(loaded.schedules.filter(schedule => schedule.enabled).length, 5);
  for (const schedule of loaded.schedules) {
    assert.deepEqual(schedule.legacy.legacy, h.tasks.find(task => task.id === schedule.legacy.source.taskId));
    assert.equal(schedule.legacy.compatibility.timezone, 'America/New_York');
    assert.ok(schedule.legacy.compatibility.pins.length > 0);
  }
  const history = loadImportedHistory(h.root);
  assert.equal(history.origins.length, 2);
  assert.equal(history.sessions.length, 2);
  assert.equal(history.archives.length, h.manifest.files.length);
  for (const archive of history.archives) assert.equal(sha256(readFileSync(archive.archivePath)), archive.sha256);
  const calls = [], assertFence = input => {
    assert.equal(owner.active, false);
    const task = JSON.parse(readFileSync(h.schedulerFile, 'utf8')).tasks.find(task => task.id === input.task.id);
    assert.equal(task.enabled, false);
  };
  const handlers = Object.fromEntries(['prompt', 'message', 'notify', 'dailyReview'].map(kind => [kind, async input => {
    assertFence(input);
    calls.push({ kind, id: input.task.id, triggerTurn: input.triggerTurn });
    return { status: 'completed', text: kind, cost: null };
  }]));
  handlers.shell = async input => {
    assertFence(input);
    calls.push({ kind: 'shell', id: input.task.id });
    return { stdout: 'Synthetic output', stderr: '', code: 0, killed: false };
  };
  const adapter = new LegacySchedules({ engine, handlers, now: () => new Date(due) }), config = loadConfig(h.root);
  const runtime = await CompanionRuntime.open(h.root, config);
  const runner = new CompanionRunner({ root, config, runtime, compatibility: adapter, now: () => new Date(due) });
  t.after(async () => {
    await runner.stop();
    await runtime.close();
  });
  for (let i = 0; i < 7; i++) {
    await runner.tick();
    await runtime.idle();
  }
  assert.equal(calls.length, 6); // Shell plus its one follow-up; all other actions once.
  assert.equal(new Set(calls.map(call => call.id)).size, 5);
  assert.equal(calls.find(call => call.kind === 'message').triggerTurn, false);
  assert.equal(calls.filter(call => call.kind === 'dailyReview').length, 1);
  const before = await runtime.state();
  assert.equal(Object.keys(before.runs).length, 5);
  assert.ok(Object.values(before.runs).every(run => run.status === 'completed'));
  await runner.stop();
  await runtime.close();
  const journalBytes = readFileSync(h.journal.file), schedulerBytes = readFileSync(h.schedulerFile);
  await h.journal.close();
  const reopened = await h.open();
  assert.deepEqual(await runUpgrade(reopened, {}), result);
  assert.deepEqual(readFileSync(reopened.file), journalBytes);
  assert.deepEqual(readFileSync(h.schedulerFile), schedulerBytes);
  assert.equal(readdirSync(join(root, 'schedules/compatibility')).length, 7);
  const restored = await CompanionRuntime.open(h.root, config);
  const next = new CompanionRunner({ root, config, runtime: restored, compatibility: adapter, now: () => new Date(due) });
  t.after(async () => {
    await next.stop();
    await restored.close();
  });
  await next.tick();
  await restored.idle();
  assert.equal(calls.length, 6);
  assert.deepEqual((await restored.state()).runs, before.runs);
});
