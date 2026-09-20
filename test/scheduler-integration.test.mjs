import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Explicit installed package roots; this test never loads the live scheduler state.
const root = process.env.PI_PACKAGE_ROOT, schedulerRoot = process.env.PI_SCHEDULER_ROOT;
if (!root || !schedulerRoot) throw Error('Set PI_PACKAGE_ROOT and PI_SCHEDULER_ROOT to already installed packages.');
const require = createRequire(join(root, 'package.json'));
const { createJiti } = require('jiti');
const host = createJiti(join(root, 'package.json'));
const aliases = Object.fromEntries(['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', '@earendil-works/pi-ai', 'typebox/value', 'typebox']
  .map(name => [name, fileURLToPath(host.esmResolve(name))]));
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: aliases });
const { controlSchedules } = await jiti.import('../src/scheduler.ts');
const { Store } = await jiti.import('../src/store.ts');
const { ExperienceStore } = await jiti.import('../src/experience.ts');
const { registerReinforcement } = await jiti.import('../src/reinforcement.ts');

test('installed scheduler controls pending and firing tasks without changing cadence or unrelated tasks', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'companion-scheduler-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const schedulerFile = join(dir, '.pi/agent/state/scheduler/tasks.json'), schedulesFile = join(dir, 'schedules.md');
  mkdirSync(join(dir, '.pi/agent/state/scheduler'), { recursive: true });
  const task = { id: 'task_owned', name: 'Reading', action: 'prompt', prompt: 'Fixture only', type: 'cron', schedule: '0 0 0 1 1 *',
    scope: 'session', sessionFile: 'owner.jsonl', cwd: dir, status: 'pending', enabled: true,
    createdAt: new Date().toISOString(), nextRun: '2099-01-01T00:00:00.000Z', dueAt: '2099-01-01T00:00:00.000Z',
    runCount: 0, whenText: '0 0 0 1 1 *' };
  writeFileSync(schedulerFile, JSON.stringify({ tasks: [task, { ...task, id: 'task_other', sessionFile: 'other.jsonl' }] }));
  writeFileSync(schedulesFile, '# Schedules\n## Reading\n');
  const previousHome = process.env.HOME, previousState = process.env.PI_SCHEDULER_STATE_FILE;
  let scheduler;
  try {
    process.env.HOME = dir;
    process.env.PI_SCHEDULER_STATE_FILE = schedulerFile;
    scheduler = (await jiti.import(join(schedulerRoot, 'extensions/scheduler/index.ts'))).default;
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousState === undefined) delete process.env.PI_SCHEDULER_STATE_FILE; else process.env.PI_SCHEDULER_STATE_FILE = previousState;
  }
  const commands = new Map(), events = new Map(), pending = [], notices = [];
  const ctx = { hasUI: true, cwd: dir, isIdle: () => true,
    sessionManager: { getSessionFile: () => 'owner.jsonl' },
    ui: { notify: (...args) => notices.push(args), setWidget() {}, setStatus() {} } };
  const pi = { on: (name, handler) => events.set(name, handler), registerCommand: (name, command) => commands.set(name, command),
    registerTool() {}, registerMessageRenderer() {},
    getCommands: () => [...commands.keys()].map(name => ({ name, sourceInfo: { path: join(schedulerRoot, 'extensions/scheduler/index.ts') } })),
    sendUserMessage: (command, options) => {
      assert.equal(options.expandPromptTemplates, true);
      const [name, id] = command.slice(1).split(' ');
      assert.ok(commands.has(name)); pending.push(commands.get(name).handler(id, ctx));
    } };
  scheduler(pi);
  t.after(async () => { await Promise.all(pending); await events.get('session_shutdown')({}, ctx); });
  await events.get('session_start')({}, ctx);
  const before = JSON.parse(readFileSync(schedulerFile, 'utf8')).tasks[1];
  const store = new Store(join(dir, 'results'), 'owner');
  await controlSchedules('stop', pi, ctx, store, { schedulerFile, schedulesFile });
  assert.equal(JSON.parse(readFileSync(schedulerFile, 'utf8')).tasks[0].enabled, false);
  assert.equal(store.load().paused.length, 1);
  await controlSchedules('start', pi, ctx, store, { schedulerFile, schedulesFile });
  const after = JSON.parse(readFileSync(schedulerFile, 'utf8')).tasks;
  assert.equal(after[0].enabled, true); assert.equal(after[0].schedule, task.schedule);
  assert.deepEqual(after[1], before);
  assert.equal(store.load().paused.length, 0);
  const core = require(join(schedulerRoot, 'extensions/scheduler/scheduler-core.cjs'));
  core.markScheduledTaskRunning(after, task.id, new Date(), { runOwner: { pid: process.pid, attemptId: 'fixture' } });
  writeFileSync(schedulerFile, JSON.stringify({ tasks: after }));
  const stopping = controlSchedules('stop', pi, ctx, store, { schedulerFile, schedulesFile });
  assert.equal(store.load().stopping.length, 1);
  core.markScheduledTaskCompleted(after, task.id, new Date(), { delivered: 'prompt' });
  writeFileSync(schedulerFile, JSON.stringify({ tasks: after }));
  await stopping;
  assert.equal(JSON.parse(readFileSync(schedulerFile, 'utf8')).tasks[0].enabled, false);
  assert.equal(store.load().paused.length, 1); assert.equal(store.load().stopping.length, 0);
  assert.equal(notices.filter(([, level]) => level === 'error').length, 0);
});

test('installed scheduler delivers an exact internal wake to isolated reflection rather than the conversation model', { timeout: 10000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'companion-daily-integration-'));
  const paths = { root: join(dir, 'memory'), schedulerFile: join(dir, 'tasks.json'), schedulesFile: join(dir, 'schedules.md'),
    reportsFile: join(dir, 'reports.md'), reviewSettingsFile: join(dir, 'teams.json') };
  writeFileSync(paths.schedulesFile, '# Schedules\n');
  writeFileSync(paths.reviewSettingsFile, JSON.stringify({ favoriteModels: { 'read-critical': { model: 'openai-codex/fixture', thinking: 'max' } } }));
  const prior = process.env.PI_SCHEDULER_STATE_FILE;
  let initialize;
  try {
    process.env.PI_SCHEDULER_STATE_FILE = paths.schedulerFile;
    initialize = (await jiti.import(join(schedulerRoot, 'extensions/scheduler/index.ts'))).default;
  } finally {
    if (prior === undefined) delete process.env.PI_SCHEDULER_STATE_FILE; else process.env.PI_SCHEDULER_STATE_FILE = prior;
  }
  const commands = new Map(), events = new Map(), pending = [], ordinaryInputs = [], calls = [], notices = [];
  const emit = async (name, event) => {
    for (const handler of events.get(name) ?? []) {
      const result = await handler(event, ctx);
      if (result?.action === 'handled') return result;
    }
  };
  let finish;
  const reflected = new Promise(resolve => { finish = resolve; });
  const model = { id: 'fixture', provider: 'openai-codex', api: 'openai-codex-responses', reasoning: true, thinkingLevelMap: { max: 'xhigh' } };
  const ctx = { hasUI: true, cwd: dir, isIdle: () => true, model,
    sessionManager: { getSessionFile: () => join(dir, 'owner.jsonl'), getSessionId: () => 'owner', getLeafId: () => 'leaf' },
    modelRegistry: { find: () => model, complete: async (...args) => {
      calls.push(args);
      return { stopReason: 'stop', content: [{ type: 'text', text: '{"assessments":[],"lessons":[],"decisions":[],"answers":[]}' }] };
    } },
    ui: { notify: (...args) => notices.push(args), setWidget() {}, setStatus() {} } };
  const pi = { on(name, handler) { events.set(name, [...events.get(name) ?? [], handler]); },
    registerCommand: (name, command) => commands.set(name, command), registerTool() {}, registerMessageRenderer() {}, sendMessage() {},
    getCommands: () => [...commands.keys()].map(name => ({ name, sourceInfo: { path: join(schedulerRoot, 'extensions/scheduler/index.ts') } })),
    sendUserMessage(text, options) {
      if (options?.expandPromptTemplates) {
        const space = text.indexOf(' ');
        pending.push(commands.get(text.slice(1, space)).handler(text.slice(space + 1), ctx));
      } else {
        pending.push(emit('input', { source: 'extension', text }).then(result => {
          if (result?.action !== 'handled') ordinaryInputs.push(text);
          if (store.load().reviews.some(review => review.status === 'completed')) finish();
        }));
      }
    } };
  initialize(pi);
  const runtime = registerReinforcement(pi, paths), store = new ExperienceStore(paths.root, 'owner');
  store.update(state => { state.wake = { token: 'isolated-fixture', schedule: '1s' }; });
  t.after(async () => { runtime.shutdown(); await emit('session_shutdown', {}); await Promise.all(pending); rmSync(dir, { recursive: true, force: true }); });
  await emit('session_start', {});
  await runtime.start(ctx);
  await reflected;
  await runtime.stop(ctx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].reasoningEffort, 'max');
  assert.equal(store.load().reviews[0].status, 'completed');
  assert.equal(ordinaryInputs.some(text => text.startsWith('[Scheduled task')), false);
  assert.equal(JSON.parse(readFileSync(paths.schedulerFile, 'utf8')).tasks.length, 1);
  assert.equal(notices.filter(([, level]) => level === 'error').length, 0);
});
