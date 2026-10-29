import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { inventoryLegacy, sha256 } from '../../src/cli/migration/inventory.mjs';
import { MigrationJournal } from '../../src/cli/migration/journal.mjs';
import { pinSession } from '../../src/cli/migration/adoption.mjs';

const at = '2026-10-26T00:00:00Z';
export async function migrationFixture(t, { malformed = false, failpoint, mutateState = () => {}, mutateTasks = () => {}, secondState = null, references = [] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'companion-cutover-'));
  const home = join(directory, 'old');
  const root = join(directory, 'new');
  const put = (path, data) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  };
  const selection = { sessionId: '15ea52c0-1a57-498c-8c65-39dbaef5c8a0', sessionFile: join(home, 'main.jsonl') };
  put(selection.sessionFile, JSON.stringify({ type: 'session', version: 3, id: selection.sessionId, cwd: home, timestamp: at }) + '\n');
  const state = {
    version: 1,
    items: [],
    paused: [],
    stopping: [],
    started: true,
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
      wake: { token: 'daily', schedule: '24h', schedulerId: 'task_wake' },
    },
  };
  mutateState(state);
  const extra = secondState ? { sessionId: '6637629d-d8b2-4b35-9afb-3f098f37c252', sessionFile: join(home, 'second.jsonl') } : null;
  if (extra) {
    put(extra.sessionFile, JSON.stringify({ type: 'session', version: 3, id: extra.sessionId, cwd: home, timestamp: at }) + '\n');
    put(join(home, `.pi/agent/companion/${sha256(extra.sessionId)}.json`), JSON.stringify(secondState));
  }
  const stateFile = join(home, `.pi/agent/companion/${sha256(selection.sessionId)}.json`);
  put(join(home, '.companion-schedules.md'), '## Routine\nOriginal instructions\n');
  put(join(home, '.companion-notes/nested/note.bin'), Buffer.from([0, 10, 255, 3]));
  put(join(home, '.companion-reports-updates.md'), 'Saved report\n<!-- historical attribution -->\n');
  const task = (id, patch = {}) => ({
    id,
    name: 'Routine',
    type: 'interval',
    action: 'prompt',
    schedule: '24h',
    intervalMs: 86400000,
    scope: 'session',
    sessionFile: selection.sessionFile,
    prompt: 'Check approved notes',
    createdAt: at,
    dueAt: at,
    nextRun: at,
    enabled: true,
    status: 'pending',
    runCount: 2,
    ...patch,
  });
  const tasks = [task('task_routine'), task('task_paused', { enabled: false, disabledAt: at }), task('task_wake', { prompt: 'companion-daily:daily' }), task('task_other', { sessionFile: '/unrelated/session.jsonl' })];
  mutateTasks(tasks, { state, selection, extra });
  put(stateFile, malformed ? '{ broken private' : JSON.stringify(state));
  const schedulerFile = join(home, '.pi/agent/state/scheduler/tasks.json');
  put(schedulerFile, JSON.stringify({ version: 2, revision: 4, updatedAt: at, unknown: 'preserve', tasks }));
  const manifest = inventoryLegacy({ home, references });
  const opened = [];
  const open = async crash => {
    const journal = await MigrationJournal.open(root, manifest, { selection, failpoint: crash });
    opened.push(journal);
    return journal;
  };
  t.after(async () => {
    for (const journal of opened) await journal.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const journal = await open(failpoint);
  const sessions = [pinSession(selection.sessionFile), ...(extra ? [pinSession(extra.sessionFile)] : [])];
  const options = {
    sessions,
    decisions: tasks.filter(task => sessions.some(session => session.sessionFile === task.sessionFile)).map(task => ({
      taskId: task.id,
      sha256: sha256(JSON.stringify(task)),
      origin: sessions.find(session => session.sessionFile === task.sessionFile).origin,
      classification: 'companion',
      timezone: 'UTC',
      reason: 'Explicit synthetic attribution.',
    })),
    config: {
      version: 2,
      initializedAt: at,
      main: { cwd: home, model: 'fixture/local', effort: 'medium' },
      background: { harness: 'pi', model: 'fixture/local', effort: 'medium' },
      concurrency: 2,
      timeoutMs: 300000,
      legacySessions: Object.fromEntries(sessions.map(session => [session.sessionId, { model: 'fixture/local', effort: 'medium' }])),
      legacyReviews: { [selection.sessionId]: { model: 'fixture/reviewer', effort: 'high' } },
    },
    controlRoot: join(directory, 'control'),
    offline: {
      confirmed: true,
      migrationId: journal.record.id,
      fingerprint: manifest.fingerprint,
      sessions: [selection, ...(extra ? [extra] : [])],
      confirmedAt: at,
    },
    engine: { validate: async (_task, timezone) => ({ version: '0.5.1', timezone, synthetic: true }) },
  };
  return { home, root, journal, open, manifest, options, tasks, state, stateFile, schedulerFile };
}
