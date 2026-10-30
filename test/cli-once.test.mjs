import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialize } from '../src/cli/config.mjs';
import { formatSchedule, loadSchedules, parseSchedule, scheduleDate } from '../src/cli/schedules.mjs';
import { CompanionRunner, dueOccurrence, nextOccurrence } from '../src/cli/runner.mjs';
import { CompanionRuntime } from '../src/cli/runtime.mjs';
import { main } from '../src/cli/main.mjs';

const metadata = {
  id: 'dentist',
  title: 'Dentist reminder',
  date: '2026-05-04',
  at: '15:00',
  timezone: 'UTC',
  enabled: true,
  harness: 'pi',
  model: 'test',
  effort: 'high',
  cwd: '/project',
  context: [],
};
const source = (patch = {}) => `---\n${JSON.stringify({ ...metadata, ...patch })}\n---\nRemind me about the dentist.\n`;
const once = (patch = {}) => ({ ...metadata, cadence: 'once', prompt: 'Remind me about the dentist.', ...patch });
const initializedAt = '2026-01-01T00:00:00Z';

function fixture(t, patch = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'companion-once-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { cwd: root, now: initializedAt });
  const save = (value = patch, name = 'dentist') =>
    writeFileSync(join(root, 'schedules/once', `${name}.md`), source({ cwd: root, ...value }));
  save();
  return { root, save };
}

test('once files need a real calendar date and no other folder accepts one', () => {
  const schedule = parseSchedule(source(), 'once', 'once/dentist.md');
  assert.equal(schedule.cadence, 'once');
  assert.equal(schedule.date, '2026-05-04');
  assert.deepEqual(parseSchedule(formatSchedule(schedule), 'once', schedule.path), schedule);
  assert.deepEqual(scheduleDate('2028-02-29'), { year: 2028, month: 2, day: 29 });
  for (const date of [undefined, null, '', '2026-5-4', '2026-02-29', '2026-13-01', '2026-04-31', '0050-01-01', '2026-05-04T15:00', 20260504]) {
    const body = JSON.stringify({ ...metadata, date });
    assert.throws(() => parseSchedule(`---\n${body}\n---\nGo.\n`, 'once', 'once/dentist.md'), /date/);
  }
  for (const cadence of ['daily', 'weekly', 'monthly']) {
    const extra = cadence === 'weekly' ? { weekday: 1 } : cadence === 'monthly' ? { day: 1 } : {};
    assert.throws(() => parseSchedule(source(extra), cadence, `${cadence}/dentist.md`), /date is for once/);
  }
});

test('once files accept times, lists, windows and a named timezone, and reject bad ones', () => {
  assert.deepEqual(parseSchedule(source({ at: ['09:00', '15:00'] }), 'once', 'p').at, ['09:00', '15:00']);
  assert.equal(parseSchedule(source({ at: undefined, window: { start: '09:00', end: '10:00', everyMinutes: 30 } }), 'once', 'p').window.everyMinutes, 30);
  assert.equal(parseSchedule(source({ timezone: 'America/Toronto' }), 'once', 'p').timezone, 'America/Toronto');
  assert.throws(() => parseSchedule(source({ timezone: 'Mars/Base' }), 'once', 'p'));
  assert.throws(() => parseSchedule(source({ timezone: undefined }), 'once', 'p'), /timezone/);
  assert.throws(() => parseSchedule(source({ at: '25:00' }), 'once', 'p'), /at must be/);
  assert.throws(() => parseSchedule(source({ weekday: 1 }), 'once', 'p'), /weekday/);
  assert.throws(() => parseSchedule(source({ day: 4 }), 'once', 'p'), /day/);
});

test('the loader reads schedules/once and counts it', t => {
  const { root, save } = fixture(t);
  save({ id: 'other', date: '2026-06-01' }, 'other');
  const loaded = loadSchedules(root);
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.counts, { daily: 0, weekly: 0, monthly: 0, once: 1 + 1 });
  assert.deepEqual(loaded.schedules.map(item => item.cadence), ['once', 'once']);
});

test('a once file is due at its local time on its date only', () => {
  const schedule = once();
  assert.equal(dueOccurrence(schedule, new Date('2026-05-04T14:59:00Z'), { notBefore: initializedAt }), null);
  assert.equal(dueOccurrence(schedule, new Date('2026-05-03T16:00:00Z'), { notBefore: initializedAt }), null);
  const due = dueOccurrence(schedule, new Date('2026-05-04T15:00:00Z'), { notBefore: initializedAt });
  assert.deepEqual(due, { id: 'dentist:2026-05-04', scheduledAt: '2026-05-04T15:00:00.000Z', localDate: '2026-05-04' });
  assert.equal(dueOccurrence({ ...schedule, timezone: 'America/Sao_Paulo' }, new Date('2026-05-04T15:00:00Z')), null);
  assert.equal(dueOccurrence({ ...schedule, timezone: 'America/Sao_Paulo' }, new Date('2026-05-04T18:00:00Z')).scheduledAt, '2026-05-04T18:00:00.000Z');
});

test('a once file catches up after downtime however late, using the latest passed time', () => {
  const late = new Date('2026-05-19T08:00:00Z');
  assert.equal(dueOccurrence(once(), late).id, 'dentist:2026-05-04');
  const list = once({ at: ['09:00', '12:00', '18:00'] });
  assert.equal(dueOccurrence(list, new Date('2026-05-04T13:00:00Z')).id, 'dentist:2026-05-04:12:00');
  assert.equal(dueOccurrence(list, late).id, 'dentist:2026-05-04:18:00');
  const window = once({ at: undefined, window: { start: '09:00', end: '11:00', everyMinutes: 60 } });
  assert.equal(dueOccurrence(window, late).id, 'dentist:2026-05-04:11:00');
  assert.equal(dueOccurrence(window, new Date('2026-05-04T10:30:00Z')).id, 'dentist:2026-05-04:10:00');
});

test('a once file never runs when disabled or when its time is not after initialization', () => {
  const late = new Date('2026-05-19T08:00:00Z');
  assert.equal(dueOccurrence(once({ enabled: false }), late), null);
  assert.equal(nextOccurrence(once({ enabled: false }), late), null);
  assert.equal(dueOccurrence(once(), late, { notBefore: '2026-05-04T15:00:00Z' }), null);
  assert.equal(dueOccurrence(once(), late, { notBefore: '2026-05-05T00:00:00Z' }), null);
  assert.equal(nextOccurrence(once(), late, { notBefore: '2026-05-05T00:00:00Z' }), null);
  assert.equal(dueOccurrence(once(), late, { notBefore: '2026-05-04T14:59:00Z' }).id, 'dentist:2026-05-04');
});

test('next occurrence is the catch-up, then the next unadmitted time, then nothing', () => {
  const schedule = once({ at: ['09:00', '15:00'] });
  assert.equal(nextOccurrence(schedule, new Date('2026-03-01T00:00:00Z')).scheduledAt, '2026-05-04T09:00:00.000Z');
  assert.equal(nextOccurrence(once(), new Date('2026-01-02T00:00:00Z')).scheduledAt, '2026-05-04T15:00:00.000Z');
  const far = once({ date: '2031-01-01' });
  assert.equal(nextOccurrence(far, new Date('2026-01-02T00:00:00Z')).scheduledAt, '2031-01-01T15:00:00.000Z');
  assert.equal(nextOccurrence(schedule, new Date('2026-05-04T10:00:00Z')).id, 'dentist:2026-05-04:09:00');
  assert.equal(nextOccurrence(schedule, new Date('2026-05-04T08:00:00Z')).id, 'dentist:2026-05-04:09:00');
  const late = new Date('2026-05-19T00:00:00Z');
  assert.equal(nextOccurrence(schedule, late).id, 'dentist:2026-05-04:15:00');
  const runs = [{ id: 'dentist:2026-05-04:15:00', scheduleId: 'dentist', scheduledAt: '2026-05-04T15:00:00.000Z', status: 'failed' }];
  assert.equal(nextOccurrence(schedule, late, { runs }), null);
  assert.equal(nextOccurrence(schedule, new Date('2026-05-04T15:30:00Z'), { runs }), null);
});

test('once dates follow timezone transitions', () => {
  const toronto = once({ timezone: 'America/Toronto', date: '2026-03-08', at: '02:30' });
  assert.equal(dueOccurrence(toronto, new Date('2026-03-09T00:00:00Z')), null);
  assert.equal(nextOccurrence(toronto, new Date('2026-03-01T00:00:00Z')), null);
  const repeated = once({ timezone: 'America/Toronto', date: '2026-11-01', at: '01:30' });
  assert.equal(dueOccurrence(repeated, new Date('2026-11-01T06:30:00Z')).scheduledAt, '2026-11-01T05:30:00.000Z');
});

class MemoryRuntime {
  data = { main: null, runs: {}, lastTick: null };
  active = new Map();

  async state() { return structuredClone(this.data); }

  dispatch(request, effect, onAdmitted) {
    if (this.data.runs[request.id]) return Promise.resolve(this.data.runs[request.id]);
    const run = this.data.runs[request.id] = { ...request, status: 'running' };
    onAdmitted?.();
    const work = Promise.resolve()
      .then(() => effect(new AbortController().signal))
      .catch(error => ({ status: 'failed', error: error.message }))
      .then(result => Object.assign(run, { status: result.status, result }))
      .finally(() => this.active.delete(request.id));
    this.active.set(request.id, work);
    return work;
  }

  async cancel() {}
  async idle() { await Promise.all(this.active.values()); }
}

function harness(t, patch, options = {}) {
  const h = fixture(t, patch);
  let now = new Date('2026-05-04T14:00:00Z');
  const prompts = [];
  const runtime = options.runtime ?? new MemoryRuntime();
  const runner = new CompanionRunner({
    root: h.root,
    runtime,
    config: { concurrency: 2, initializedAt },
    now: () => now,
    runHarness: async request => {
      prompts.push(request.prompt);
      return options.outcome ?? { status: 'completed', text: 'Reminded' };
    },
  });
  t.after(() => runner.stop());
  return { ...h, runner, runtime, prompts, at: value => { now = new Date(value); } };
}

const tickAt = async (h, time) => {
  h.at(time);
  await h.runner.tick();
  await h.runtime.idle();
};
const nextRun = async h => (await h.runner.snapshot()).schedules[0].nextRun;

test('the runner starts a once file at its time, shows scheduled then done, and never repeats', async t => {
  const h = harness(t);
  await tickAt(h, '2026-05-04T14:00:00Z');
  assert.equal(h.prompts.length, 0);
  assert.deepEqual(await nextRun(h), { state: 'scheduled', at: '2026-05-04T15:00:00.000Z' });
  await tickAt(h, '2026-05-04T15:00:30Z');
  assert.equal(h.prompts.length, 1);
  assert.deepEqual(await nextRun(h), { state: 'done', at: null });
  await tickAt(h, '2026-05-04T15:01:00Z');
  await tickAt(h, '2026-05-05T15:00:00Z');
  await tickAt(h, '2027-05-04T15:00:00Z');
  assert.equal(h.prompts.length, 1);
  assert.deepEqual(await nextRun(h), { state: 'done', at: null });
});

test('the runner catches up a missed once file at the next tick and then stays done', async t => {
  const h = harness(t);
  await tickAt(h, '2026-05-19T09:00:00Z');
  assert.equal(h.prompts.length, 1);
  const [run] = Object.values(h.runtime.data.runs);
  assert.equal(run.scheduledAt, '2026-05-04T15:00:00.000Z');
  await tickAt(h, '2026-05-19T09:00:05Z');
  assert.equal(h.prompts.length, 1);
  assert.deepEqual(await nextRun(h), { state: 'done', at: null });
});

test('a failed or incomplete once run is still done and is not retried', async t => {
  const h = harness(t, {}, { outcome: { status: 'failed', error: 'provider down' } });
  await tickAt(h, '2026-05-04T15:00:00Z');
  await tickAt(h, '2026-05-04T16:00:00Z');
  assert.equal(h.prompts.length, 1);
  assert.equal(Object.values(h.runtime.data.runs)[0].status, 'failed');
  assert.deepEqual(await nextRun(h), { state: 'done', at: null });
});

test('a once run admitted before a restart does not repeat, even if its file changes to a list', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'companion-once-real-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { cwd: root, now: initializedAt });
  const save = patch => writeFileSync(join(root, 'schedules/once/dentist.md'), source({ cwd: root, ...patch }));
  save();
  let calls = 0;
  const config = { concurrency: 2, initializedAt };
  const open = async now => {
    const runtime = await CompanionRuntime.open(root, config);
    const runner = new CompanionRunner({ root, runtime, config, now: () => new Date(now), runHarness: async () => { calls++; return { status: 'completed', text: 'Reminded' }; } });
    return { runtime, runner };
  };
  let session = await open('2026-05-10T10:00:00Z');
  await session.runner.tick();
  await session.runtime.idle();
  assert.equal(calls, 1);
  await session.runner.stop();
  await session.runtime.close();
  save({ at: ['09:00', '15:00'] });
  session = await open('2026-05-10T12:00:00Z');
  try {
    await session.runner.tick();
    await session.runtime.idle();
    assert.equal(calls, 1);
    const [next] = (await session.runner.snapshot()).schedules;
    assert.equal(next.nextRun.state, 'done');
  } finally {
    await session.runner.stop();
    await session.runtime.close();
  }
});

test('each time of a once list runs once and earlier missed times are skipped', async t => {
  const h = harness(t, { at: ['09:00', '12:00', '15:00'] });
  await tickAt(h, '2026-05-04T12:30:00Z');
  assert.equal(h.prompts.length, 1);
  assert.deepEqual(await nextRun(h), { state: 'scheduled', at: '2026-05-04T15:00:00.000Z' });
  await tickAt(h, '2026-05-04T15:05:00Z');
  assert.equal(h.prompts.length, 2);
  assert.deepEqual(await nextRun(h), { state: 'done', at: null });
  await tickAt(h, '2026-05-06T00:00:00Z');
  assert.equal(h.prompts.length, 2);
});

test('a disabled once file is paused and never runs; enabling it afterwards catches up', async t => {
  const h = harness(t, { enabled: false });
  await tickAt(h, '2026-05-19T09:00:00Z');
  assert.equal(h.prompts.length, 0);
  assert.deepEqual(await nextRun(h), { state: 'paused', at: null });
  h.save({ enabled: true });
  await tickAt(h, '2026-05-19T09:01:00Z');
  assert.equal(h.prompts.length, 1);
});

test('a once file whose time passed before initialization is expired, not scheduled or done', async t => {
  const h = harness(t, { date: '2025-12-31' });
  await tickAt(h, '2026-05-04T09:00:00Z');
  assert.equal(h.prompts.length, 0);
  assert.deepEqual(await nextRun(h), { state: 'expired', at: null });
});

test('a once file is running while its job runs', async t => {
  const h = harness(t);
  await tickAt(h, '2026-05-04T14:00:00Z');
  h.runtime.data.runs.live = { scheduleId: 'dentist', status: 'running', scheduledAt: '2026-05-04T15:00:00.000Z' };
  assert.deepEqual(await nextRun(h), { state: 'running', at: null });
});

test('a manual run of a once file works, leaves it pending and does not consume it', async t => {
  const h = harness(t);
  await h.runner.tick();
  assert.deepEqual((await h.runner.trigger()).schedules, [{ id: 'dentist', title: 'Dentist reminder', enabled: true }]);
  const manual = await h.runner.trigger('dentist', 'request-1');
  assert.equal(manual.status, 'running');
  await h.runtime.idle();
  assert.equal(h.prompts.length, 1);
  assert.deepEqual(await nextRun(h), { state: 'scheduled', at: '2026-05-04T15:00:00.000Z' });
  await tickAt(h, '2026-05-04T15:00:00Z');
  assert.equal(h.prompts.length, 2);
  assert.deepEqual(await nextRun(h), { state: 'done', at: null });
  const paused = harness(t, { enabled: false });
  await paused.runner.tick();
  assert.equal((await paused.runner.trigger('dentist', 'request-2')).status, 'running');
});

test('status prints the Once count and the once schedule', async t => {
  const { root } = fixture(t);
  let text = '';
  const code = await main(['status', '--home', root, '--plain'], { isTTY: false, write: value => { text += value; } });
  assert.equal(code, 0);
  assert.match(text, /Daily 0 · Weekly 0 · Monthly 0 · Once 1 · Migrated 0/);
  assert.match(text, /enabled {2}once\/dentist {2}Dentist reminder/);
});
