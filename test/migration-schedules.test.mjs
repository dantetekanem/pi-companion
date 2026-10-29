import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inventoryLegacy, sha256 } from '../src/cli/migration/inventory.mjs';
import { pinSession, validateOwnership } from '../src/cli/migration/ownership.mjs';
import { MigrationJournal } from '../src/cli/migration/journal.mjs';
import { importStates } from '../src/cli/migration/state.mjs';
import { importSchedules, scheduleSignature } from '../src/cli/migration/schedules.mjs';

const at = '2026-03-07T17:00:00.000Z';
const engine = { validate: async (task, timezone) => ({ version: '0.5.1', timezone, fixture: true }) };
const task = (id, values = {}) => ({
  id: `task_${id}`,
  name: 'Routine',
  action: 'prompt',
  type: 'interval',
  schedule: '24h',
  intervalMs: 86400000,
  createdAt: at,
  dueAt: at,
  nextRun: at,
  enabled: true,
  status: 'pending',
  runCount: 3,
  scope: 'session',
  prompt: 'Inspect the selected repository.',
  ...values,
});
async function fixture(t, tasks, state = { version: 1, items: [], paused: [], started: true }) {
  const root = mkdtempSync(join(tmpdir(), 'companion-schedules-migration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const sessionFile = join(root, 'owner.jsonl');
  const sessionId = 'synthetic-owner';
  const put = (path, content) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  put(sessionFile, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd: home }) + '\n');
  tasks = tasks.map(value => ({ sessionFile, ...value }));
  if (typeof state === 'function') state = state(tasks);
  put(join(home, `.pi/agent/companion/${sha256(sessionId)}.json`), JSON.stringify(state));
  put(join(home, '.companion-schedules.md'), '# Routines\n\n## Routine\nPrivate instructions.\n');
  put(join(home, '.pi/agent/state/scheduler/tasks.json'), JSON.stringify({ version: 2, revision: 4, updatedAt: at, extra: 'preserved', tasks }));
  const manifest = inventoryLegacy({ home });
  const selection = { sessionFile, sessionId };
  const ownership = validateOwnership({
    manifest,
    selection,
    quiescence: {
      kind: 'host-shutdown',
      fingerprint: manifest.fingerprint,
      receiptId: 'fixture-shutdown',
      observedAt: at,
      sessions: [{ sessionId, state: 'stopped' }],
    },
  });
  const journal = await MigrationJournal.open(join(root, 'destination'), manifest, { selection });
  t.after(() => journal.close());
  await journal.stage();
  const states = importStates(journal);
  const decisions = tasks.filter(value => value.sessionFile === sessionFile).map(value => ({
    taskId: value.id,
    sha256: sha256(JSON.stringify(value)),
    origin: ownership.main.origin,
    classification: 'companion',
    timezone: 'America/New_York',
    reason: 'Explicit fixture attribution.',
  }));
  const options = { ownership, states, decisions, sessions: [ownership.main], engine };
  return { journal, tasks, options, load: artifact => JSON.parse(readFileSync(journal.dataPath(artifact.path), 'utf8')) };
}

test('preserves every selected action, cadence, unknown field and disabled state in a compatibility record', async t => {
  const records = [
    task('interval', { backoff: { factor: 2, maxIntervalMs: 172800000, currentIntervalMs: 86400000 }, custom: { retained: true } }),
    task('once', { type: 'once', schedule: '2026-03-08T17:00:00Z', action: 'notify', message: 'Reminder' }),
    task('hourly', { type: 'cron', schedule: '0 * * * *', action: 'shell', command: 'printf fixture', wakeOn: 'change', stopOn: 'success', timeoutMs: 1000, followUpPrompt: 'Summarize', maxRuns: 5, expiresAt: '2026-04-01T00:00:00Z' }),
    task('monthly', { type: 'cron', schedule: '0 9 1,15 * *', action: 'message', message: 'Inspect', triggerTurn: false, enabled: false, disabledAt: at }),
    task('cancelled', { enabled: false, status: 'cancelled', cancelledAt: at }),
  ];
  const { journal, options, tasks, load } = await fixture(t, records);
  const result = await importSchedules(journal, options);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.scheduleIds, tasks.map(value => value.id));
  assert.deepEqual(result.validatedScheduleIds, result.scheduleIds);
  const schedules = result.artifacts.filter(value => value.kind === 'schedule').map(load);
  assert.equal(schedules.length, tasks.length);
  for (const [index, value] of schedules.entries()) {
    assert.deepEqual(value.legacy, tasks[index]);
    assert.equal(value.timezone, 'America/New_York');
    assert.equal(value.origin, options.ownership.main.origin);
    assert.equal(value.session.sha256, options.ownership.main.sha256);
    assert.equal(value.source.sha256, sha256(JSON.stringify(tasks[index])));
  }
  assert.equal(schedules[0].legacy.intervalMs, 86400000); // Never a local-calendar "daily" conversion across DST.
  assert.deepEqual(await importSchedules(journal, options), result);
  assert.equal(journal.verifyArchive(), true);
});

test('same-name tasks outside the mapped session stay unrelated; same-session ambiguity blocks completion', async t => {
  const { journal, tasks, options, load } = await fixture(t, [task('owned'), task('unrelated', { sessionFile: '/different/session.jsonl' }), task('ambiguous')]);
  options.decisions.pop();
  const blocked = await importSchedules(journal, options);
  assert.ok(blocked.errors.some(error => error.taskId === 'task_ambiguous' && error.code === 'attribution_required'));
  assert.ok(!blocked.scheduleIds.includes('task_unrelated'));
  options.decisions.push({ taskId: tasks[2].id, sha256: sha256(JSON.stringify(tasks[2])), origin: options.ownership.main.origin, classification: 'unrelated', reason: 'Confirmed separate task.' });
  const result = await importSchedules(journal, options);
  assert.deepEqual(result.errors, []);
  const index = load(result.artifacts.find(value => value.kind === 'index'));
  assert.deepEqual(index.unrelatedIds, ['task_unrelated', 'task_ambiguous']);
  assert.equal(index.decisions.length, 2);
});

test('changed signatures, unconfirmed stops and active runs block rather than resuming work', async t => {
  const disabled = task('disabled', { enabled: false, disabledAt: at });
  const { journal, options } = await fixture(t, [disabled], { version: 1, items: [], paused: [{ id: disabled.id, signature: 'changed', disabledAt: at }], stopping: [], started: false });
  assert.ok((await importSchedules(journal, options)).errors.some(error => error.code === 'changed_receipt'));
  options.decisions[0].sha256 = '0'.repeat(64);
  assert.ok((await importSchedules(journal, options)).errors.some(error => error.code === 'changed_selection'));
  const active = await fixture(t, [task('active', { status: 'running', runOwner: { attemptId: 'old' } })]);
  assert.ok((await importSchedules(active.journal, active.options)).errors.some(error => error.code === 'active_attempt'));
  const stopped = await fixture(t, [task('stopping')], { version: 1, items: [], paused: [], stopping: [{ id: 'task_stopping', signature: 'pending' }] });
  assert.ok((await importSchedules(stopped.journal, stopped.options)).errors.some(error => error.code === 'stop_incomplete'));
});

test('daily-wake references must resolve exactly, and malformed or unsupported owned records remain errors', async t => {
  const wake = { token: 'token', schedule: '24h', schedulerId: 'task_wake' };
  const experience = { version: 1, enabled: true, generation: 1, wake, evidence: [], questions: [], decisions: [], lessons: [], assessments: [], reviews: [] };
  const { journal, options, load } = await fixture(t, [task('wake', { name: 'Daily review', prompt: 'companion-daily:token' })], { version: 1, items: [], paused: [], experience });
  const result = await importSchedules(journal, options);
  assert.deepEqual(result.errors, []);
  assert.equal(load(result.artifacts.find(value => value.kind === 'schedule')).role, 'daily-wake');
  options.decisions[0].classification = 'unrelated';
  assert.ok((await importSchedules(journal, options)).errors.some(error => error.code === 'owned_reference'));
  const missing = await fixture(t, [], { version: 1, items: [], paused: [], experience });
  assert.ok((await importSchedules(missing.journal, missing.options)).errors.some(error => error.code === 'missing_schedule'));
  const invalid = await fixture(t, [task('bad', { action: 'unknown' })]);
  assert.ok((await importSchedules(invalid.journal, invalid.options)).errors.some(error => error.code === 'invalid_schedule'));
});

test('a later origin wake cannot erase another origin control claim', async t => {
  for (const control of ['stopping', 'paused']) {
    const root = mkdtempSync(join(tmpdir(), 'companion-origin-collision-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, 'home');
    const put = (path, value) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, value);
    };
    const sessions = ['b', 'a'].map(id => {
      const sessionFile = join(root, `${id}.jsonl`);
      put(sessionFile, JSON.stringify({ type: 'session', version: 3, id, cwd: home }) + '\n');
      return pinSession(sessionFile);
    });
    assert.ok(sessions[0].origin < sessions[1].origin);
    const wakeTask = task('wake', { sessionFile: sessions[1].sessionFile, prompt: 'companion-daily:token' });
    const foreign = {
      version: 1,
      items: [],
      paused: [],
      [control]: [{
        id: 'task_wake',
        signature: 'unresolved',
        ...(control === 'paused' ? { disabledAt: at } : {}),
      }],
    };
    const owner = {
      version: 1,
      items: [],
      paused: [],
      experience: {
        version: 1,
        enabled: true,
        generation: 1,
        evidence: [],
        questions: [],
        lessons: [],
        decisions: [],
        assessments: [],
        reviews: [],
        wake: { schedulerId: 'task_wake', token: 'token', schedule: '24h' },
      },
    };
    for (const [index, state] of [foreign, owner].entries()) {
      put(join(home, `.pi/agent/companion/${sha256(sessions[index].sessionId)}.json`), JSON.stringify(state));
    }
    put(join(home, '.pi/agent/state/scheduler/tasks.json'), JSON.stringify({ version: 2, tasks: [wakeTask] }));
    const manifest = inventoryLegacy({ home });
    const selection = { sessionId: sessions[1].sessionId, sessionFile: sessions[1].sessionFile };
    const journal = await MigrationJournal.open(join(root, 'destination'), manifest, { selection });
    t.after(() => journal.close());
    await journal.stage();
    const ownership = validateOwnership({
      manifest,
      selection,
      quiescence: {
        kind: 'host-shutdown',
        fingerprint: manifest.fingerprint,
        receiptId: 'fixture-shutdown',
        observedAt: at,
        sessions: sessions.map(session => ({ sessionId: session.sessionId, state: 'stopped' })),
      },
    });
    const result = await importSchedules(journal, {
      ownership,
      sessions,
      states: importStates(journal),
      engine,
      decisions: [{
        taskId: wakeTask.id,
        sha256: sha256(JSON.stringify(wakeTask)),
        origin: sessions[1].origin,
        classification: 'companion',
        timezone: 'UTC',
        reason: 'Explicit owner',
      }],
    });
    assert.ok(result.errors.some(error => ['stop_incomplete', 'session_mapping'].includes(error.code)), JSON.stringify(result));
    assert.equal(journal.record.phase, 'staged');
    assert.equal(existsSync(join(journal.root, 'active.json')), false);
  }
});

test('exact pause receipts and stopped origins survive while engine validation failures block the full set', async t => {
  const raw = task('paused', { enabled: false, disabledAt: at });
  const { journal, options, tasks, load } = await fixture(t, [raw], tasks => ({
    version: 1,
    items: [],
    paused: [{ id: raw.id, signature: scheduleSignature(tasks[0]), disabledAt: at }],
    started: false,
  }));
  const result = await importSchedules(journal, options);
  assert.deepEqual(result.errors, []);
  const imported = load(result.artifacts.find(value => value.kind === 'schedule'));
  assert.equal(imported.control.started, false);
  assert.deepEqual(imported.control.paused, { id: raw.id, signature: scheduleSignature(tasks[0]), disabledAt: at });
  const rejected = await importSchedules(journal, { ...options, engine: { validate: async () => { throw Error('unsupported persisted state'); } } });
  assert.equal(rejected.scheduleIds.length, 1);
  assert.equal(rejected.validatedScheduleIds.length, 0);
  assert.equal(rejected.errors[0].code, 'engine_validation');
});
