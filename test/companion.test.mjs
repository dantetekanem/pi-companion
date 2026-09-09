import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Use Pi's already installed loader and bundled peers; never install during tests.
const require = createRequire(process.env.PI_PACKAGE_ROOT
  ? join(process.env.PI_PACKAGE_ROOT, 'package.json') : import.meta.url);
const root = process.env.PI_PACKAGE_ROOT || resolve(require.resolve('@earendil-works/pi-coding-agent'), '../..');
const { createJiti } = require('jiti');
const host = createJiti(join(root, 'package.json'));
const aliases = Object.fromEntries(['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox/value', 'typebox']
  .map(name => [name, fileURLToPath(host.esmResolve(name))]));
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: aliases });
const { Store } = await jiti.import('../src/store.ts');
const { footer, label, validateResult } = await jiti.import('../src/result.ts');
const { Reader } = await jiti.import('../src/reader.ts');
const { controlSchedules } = await jiti.import('../src/scheduler.ts');
const { registerCompanion } = await jiti.import('../src/index.ts');
const { companionInstructions } = await jiti.import('../src/instructions.ts');
const { visibleWidth } = await jiti.import(aliases['@earendil-works/pi-tui']);
const report = (id = 'digest-1', outcome = 'no_change') => ({
  id, kind: 'report', final: true, title: 'Reading', body: 'Useful result with evidence.',
  checks: [{ source: 'Paper source', outcome, detail: 'Checked the current listing.' }],
});
const update = (id = 'update-1') => ({ ...report(id, 'findings'), kind: 'update', reason: 'action', title: 'Review a breaking change' });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'companion-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new Store(dir, 'owner') };
}

test('installed Pi loader discovers the real extension without starting a session', async t => {
  const { dir } = fixture(t);
  const { loadExtensions } = await import(join(root, 'dist/core/extensions/loader.js'));
  const loaded = await loadExtensions([fileURLToPath(new URL('../src/index.ts', import.meta.url))], dir);
  assert.deepEqual(loaded.errors, []);
  assert.ok(loaded.extensions[0].tools.has('companion_save'));
  assert.ok(loaded.extensions[0].commands.has('companion'));
});

test('save survives a new store instance; opening is not reading; explicit read persists', t => {
  const { dir, store } = fixture(t);
  store.ingest(update()); store.ingest(report());
  assert.equal(footer(store.load()), 'Companion · 1 update · 1 report');
  assert.equal(new Store(dir, 'owner').load().items.length, 2);
  store.load();
  assert.equal(store.load().items[0].readAt, undefined);
  store.markRead('update-1');
  assert.ok(new Store(dir, 'owner').load().items[0].readAt);
  assert.equal(footer(store.load()), 'Companion · 1 report');
  assert.equal(statSync(store.file).mode & 0o777, 0o600);
});

test('other sessions and forks have independent storage and unread state', t => {
  const { dir, store } = fixture(t);
  store.ingest(update());
  const other = new Store(dir, 'other');
  assert.deepEqual(other.load().items, []);
  other.ingest(update()); other.markRead('update-1');
  assert.equal(store.load().items[0].readAt, undefined);
});

test('retry is idempotent, preserves read state, and conflicting IDs cannot overwrite', t => {
  const { store } = fixture(t);
  store.ingest(report()); store.markRead('digest-1');
  assert.equal(store.ingest(report()), false);
  assert.ok(store.load().items[0].readAt);
  assert.throws(() => store.ingest({ ...report(), body: 'Changed' }), /already exists/);
  assert.equal(store.load().items.length, 1);
});

test('no-change belongs to a saved report; gaps remain explicit and make it incomplete', t => {
  const { store } = fixture(t);
  const result = report();
  result.checks.push(...['failed', 'incomplete', 'not_run'].map(outcome => ({ source: outcome, outcome, detail: 'Source unavailable or task did not run.' })));
  store.ingest(result);
  assert.equal(label(store.load().items[0]), 'Reading report incomplete');
  assert.equal(store.load().items[0].checks.length, 4);
  assert.equal(footer(store.load()), 'Companion · 1 report');
  assert.throws(() => validateResult({ ...report(), kind: 'update', reason: 'material' }), /finding/);
  assert.throws(() => validateResult({ ...report(), final: false }), /Invalid/);
  assert.throws(() => validateResult({ ...report(), checks: [] }), /Invalid/);
});

test('explicit incomplete blocker can be an update, without claiming collection succeeded', t => {
  const { store } = fixture(t);
  store.ingest({ ...report('blocker', 'failed'), kind: 'update', reason: 'blocker' });
  assert.match(label(store.load().items[0]), /incomplete/);
  assert.equal(footer(store.load()), 'Companion · 1 update');
});

test('invalid input, unsafe terminal controls and malformed storage fail closed', t => {
  const { store } = fixture(t);
  for (const patch of [{ title: '\u001b[31munsafe' }, { title: 'Trailing newline\n' }, { id: 'id\n' }, { body: 'x'.repeat(33000) }, { sessionId: 'other' }, { title: '   ' }]) {
    assert.throws(() => store.ingest({ ...report(), ...patch }));
  }
  store.ingest(report());
  writeFileSync(store.file, '{');
  assert.throws(() => store.load());
  assert.throws(() => store.ingest(update()));
  assert.equal(readFileSync(store.file, 'utf8'), '{');
});

test('a failed durable write does not produce a saved result', t => {
  const { dir } = fixture(t);
  const blocked = join(dir, 'not-directory'); writeFileSync(blocked, 'occupied');
  const store = new Store(blocked, 'owner');
  assert.throws(() => store.ingest(report()));
});

function harness(t, sessionId = 'owner', paths) {
  const fixturePaths = paths ?? fixture(t);
  const options = { root: fixturePaths.dir, schedulerFile: join(fixturePaths.dir, 'tasks.json'), schedulesFile: join(fixturePaths.dir, 'schedules.md') };
  const events = new Map(), tools = new Map(), commands = new Map(), statuses = [], notices = [], selections = [];
  const ctx = { mode: 'tui', hasUI: true, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => `${sessionId}.jsonl` },
    ui: { setStatus: (key, value) => statuses.push([key, value]), notify: (...args) => notices.push(args),
      select: async (title, choices) => { selections.push({ title, choices }); return undefined; }, custom: async () => false } };
  const messages = [], pi = { on: (name, fn) => events.set(name, fn), registerTool: tool => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command), getCommands: () => [],
    sendUserMessage: (content, options) => messages.push({ content, options }) };
  registerCompanion(pi, options);
  return { ...fixturePaths, pi, ctx, options, events, tools, commands, statuses, notices, selections, messages,
    command: args => commands.get('companion').handler(args, ctx),
    ingest: params => tools.get('companion_save').execute('call', params, undefined, undefined, ctx) };
}

test('real tool ingestion drives the footer; reload restores it; scheduler/agent events do not manufacture results', async t => {
  const h = harness(t);
  await h.command('start');
  await h.events.get('session_start')({}, h.ctx);
  assert.equal(h.statuses.at(-1)[1], undefined);
  for (const event of ['input', 'agent_end', 'agent_settled', 'tool_result']) await h.events.get(event)?.({ task: { status: 'fired' } }, h.ctx);
  assert.equal(new Store(h.dir, 'owner').load().items.length, 0);
  await h.ingest(report());
  assert.equal(h.statuses.at(-1)[1], 'Companion · 1 report');
  const reloaded = harness(t, 'owner', h);
  await reloaded.events.get('session_start')({}, reloaded.ctx);
  assert.equal(reloaded.statuses.at(-1)[1], 'Companion · 1 report');
  const other = harness(t, 'other', h);
  await other.events.get('session_start')({}, other.ctx);
  assert.equal(other.statuses.at(-1)[1], undefined);
  await h.ingest(update());
  assert.equal(other.statuses.at(-1)[1], undefined);
});

test('direct views filter updates/reports; only an explicit reader action marks read', async t => {
  const h = harness(t); await h.ingest(report()); await h.ingest(update());
  await h.command('updates'); assert.equal(h.selections.at(-1).choices.length, 1);
  await h.command('reports'); assert.equal(h.selections.at(-1).choices.length, 1);
  let selected = false;
  h.ctx.ui.select = async (_title, choices) => { if (selected) return; selected = true; return choices[0]; };
  await h.command('updates');
  assert.equal(new Store(h.dir, 'owner').load().items.find(i => i.kind === 'update').readAt, undefined);
  selected = false; h.ctx.ui.custom = async () => true;
  await h.command('updates');
  assert.ok(new Store(h.dir, 'owner').load().items.find(i => i.kind === 'update').readAt);
  await h.command('reports');
  assert.equal(new Store(h.dir, 'owner').load().items.find(i => i.kind === 'report').readAt, undefined);
});

test('start and bare companion send bundled instructions directly; autocomplete follows Pi\'s null contract', async t => {
  const h = harness(t), command = h.commands.get('companion');
  assert.deepEqual(command.getArgumentCompletions('')?.map(item => item.value), ['updates', 'reports', 'start', 'stop']);
  assert.deepEqual(command.getArgumentCompletions('rep')?.map(item => item.value), ['reports']);
  assert.equal(command.getArgumentCompletions('missing'), null);
  await h.command('start'); await h.command('');
  assert.deepEqual(h.messages, [
    { content: companionInstructions, options: { deliverAs: 'followUp' } },
    { content: companionInstructions, options: { deliverAs: 'followUp' } },
  ]);
  assert.equal(h.selections.length, 0);
});

test('sessions independently start Companion and stop only their own schedules', async t => {
  const scheduler = schedulerFixture(t);
  writeFileSync(join(scheduler.dir, 'owner.json'), JSON.stringify({ version: 1, sessionId: 'retired-session' }));
  const first = harness(t, 'owner', scheduler), second = harness(t, 'other', scheduler);
  for (const runtime of [first, second]) {
    runtime.pi.getCommands = scheduler.pi.getCommands;
    runtime.pi.sendUserMessage = (content, options) => {
      if (content === companionInstructions) runtime.messages.push({ content, options });
      else scheduler.pi.sendUserMessage(content, options);
    };
    await runtime.command('start');
    assert.equal(runtime.messages.length, 1);
    await runtime.ingest(report());
    assert.equal(runtime.statuses.at(-1)[1], 'Companion · 1 report');
  }
  await second.command('stop');
  assert.deepEqual(scheduler.sent, ['/schedule-disable task_other']);
  assert.equal(scheduler.tasks[0].enabled, true);
  await first.command('stop');
  assert.deepEqual(scheduler.sent, ['/schedule-disable task_other', '/schedule-disable task_owned']);
});

test('identifiable Companion schedule creation is session-scoped in every session', async t => {
  const scheduler = schedulerFixture(t);
  const owner = harness(t, 'owner', scheduler), other = harness(t, 'other', scheduler);
  const gate = owner.events.get('tool_call');
  assert.deepEqual(await gate({ toolName: 'schedule_task', input: { name: 'Reading', scope: 'cwd' } }, owner.ctx),
    { block: true, reason: 'Companion schedules must use session scope.' });
  assert.equal(await gate({ toolName: 'schedule_task', input: { name: 'CI poll', scope: 'global' } }, owner.ctx), undefined);
  await owner.command('start');
  assert.equal(await gate({ toolName: 'schedule_task', input: { name: 'Reading', scope: 'session' } }, owner.ctx), undefined);
  assert.equal(await gate({ toolName: 'schedule_task', input: { name: 'Reading', scope: 'session' } }, other.ctx), undefined);
});

test('reader scrolls long results within terminal bounds and distinguishes close from mark-read', () => {
  const done = [], theme = { fg: (_c, text) => text, bold: text => text };
  const reader = new Reader({ ...report(), body: Array.from({ length: 60 }, (_, i) => `Line ${i} wide 界`).join('\n') }, theme, () => 12, value => done.push(value));
  const first = reader.render(24);
  assert.ok(first.length <= 12); assert.ok(first.every(line => visibleWidth(line) <= 24));
  reader.handleInput('\u001b[B'); assert.notDeepEqual(reader.render(24), first);
  reader.handleInput('\u001b'); assert.deepEqual(done, [false]);
  const second = new Reader(report(), theme, () => 12, value => done.push(value));
  second.handleInput('r'); assert.deepEqual(done, [false, true]);
  for (const width of [1, 8, 40]) assert.ok(second.render(width).every(line => visibleWidth(line) <= width));
});

function schedulerFixture(t) {
  const { dir, store } = fixture(t);
  const schedulerFile = join(dir, 'tasks.json'), schedulesFile = join(dir, 'schedules.md');
  writeFileSync(schedulesFile, '# Schedules\n## Reading\n## Mail\n');
  const task = (id, patch = {}) => ({ id, name: 'Reading', scope: 'session', sessionFile: 'owner.jsonl', type: 'cron', schedule: '0 9 * * 5', status: 'pending', enabled: true, ...patch });
  const tasks = [task('task_owned'), task('task_other', { sessionFile: 'other.jsonl' }), task('task_global', { scope: 'global' }),
    task('task_finance', { name: 'Finance updates' }), task('task_cancelled', { enabled: false, status: 'cancelled' }),
    task('task_manual', { enabled: false }), task('task_once', { type: 'once' }), task('task_unrelated', { name: 'CI poll' }),
    task('task_suffix', { name: 'Reading (other work)' })];
  const save = () => writeFileSync(schedulerFile, JSON.stringify({ tasks })); save();
  const sent = [], pi = {
    getCommands: () => ['schedule-enable', 'schedule-disable'].map(name => ({ name, sourceInfo: { path: '/test/@jl1990/pi-scheduler/extensions/scheduler/index.ts' } })),
    sendUserMessage: (command, options) => {
      sent.push(command); assert.equal(options.expandPromptTemplates, true);
      const [verb, id] = command.split(' '); const item = tasks.find(task => task.id === id);
      item.enabled = verb === '/schedule-enable'; if (!item.enabled) item.disabledAt = `paused-${sent.length}`; save();
    },
  };
  return { dir, store, tasks, save, sent, pi, options: { schedulerFile, schedulesFile }, ctx: { sessionManager: { getSessionFile: () => 'owner.jsonl' } } };
}

test('stop uses existing commands only for owned approved recurring work; start resumes only its receipts', async t => {
  const h = schedulerFixture(t);
  await controlSchedules('stop', h.pi, h.ctx, h.store, h.options);
  assert.deepEqual(h.sent, ['/schedule-disable task_owned']);
  assert.equal(h.store.load().paused.length, 1);
  await controlSchedules('stop', h.pi, h.ctx, h.store, h.options);
  assert.equal(h.sent.length, 1);
  await controlSchedules('start', h.pi, h.ctx, h.store, h.options);
  assert.deepEqual(h.sent, ['/schedule-disable task_owned', '/schedule-enable task_owned']);
  assert.equal(h.store.load().paused.length, 0);
  assert.equal(h.tasks[0].schedule, '0 9 * * 5');
});

test('stop persists its intent, waits for a firing delivery, then disables without aborting it', async t => {
  const h = schedulerFixture(t); h.tasks[0].status = 'running'; h.save();
  const stopping = controlSchedules('stop', h.pi, h.ctx, h.store, h.options);
  assert.equal(new Store(h.dir, 'owner').load().stopping?.length, 1);
  assert.equal(h.sent.length, 0);
  Object.assign(h.tasks[0], { status: 'pending', enabled: true, runCount: 1 }); h.save();
  await stopping;
  assert.deepEqual(h.sent, ['/schedule-disable task_owned']);
  assert.equal(h.tasks[0].enabled, false); assert.equal(h.store.load().paused.length, 1);
  assert.equal(h.store.load().stopping.length, 0);
});

test('a deferred stop rechecks approval after the running delivery finishes', async t => {
  const h = schedulerFixture(t); h.tasks[0].status = 'running'; h.save();
  const stopping = controlSchedules('stop', h.pi, h.ctx, h.store, h.options);
  writeFileSync(h.options.schedulesFile, '# No approved schedules\n');
  h.tasks[0].status = 'pending'; h.save(); await stopping;
  assert.equal(h.sent.length, 0); assert.equal(h.store.load().paused.length, 0);
});

test('a reload resumes deferred stop only in its owning session', async t => {
  const h = schedulerFixture(t); h.tasks[0].status = 'running'; h.save();
  let active = true;
  const stopping = controlSchedules('stop', h.pi, h.ctx, h.store, { ...h.options, isActive: () => active });
  active = false;
  await assert.rejects(stopping, /session changed/);
  h.tasks[0].status = 'pending'; h.save();
  const other = harness(t, 'other', h);
  await other.events.get('session_start')({}, other.ctx);
  assert.equal(h.sent.length, 0);
  const reloaded = harness(t, 'owner', h);
  Object.assign(reloaded.pi, { getCommands: h.pi.getCommands, sendUserMessage: h.pi.sendUserMessage });
  await reloaded.events.get('session_start')({}, reloaded.ctx);
  assert.deepEqual(h.sent, ['/schedule-disable task_owned']);
  assert.equal(h.store.load().paused.length, 1); assert.equal(h.store.load().items.length, 0);
});

test('successful session recovery completes the stop and preserves saved results', async t => {
  const h = schedulerFixture(t); h.tasks[0].status = 'running'; h.save();
  const runtime = harness(t, 'owner', h);
  Object.assign(runtime.pi, { getCommands: h.pi.getCommands, sendUserMessage: h.pi.sendUserMessage });
  await runtime.ingest(report('recovery-history'));
  assert.equal(runtime.statuses.at(-1)[1], 'Companion · 1 report');
  const stopping = runtime.command('stop');
  assert.equal(new Store(h.dir, 'owner').load().stopping.length, 1);
  await runtime.events.get('session_shutdown')({}, runtime.ctx);
  await stopping;
  await new Promise(setImmediate);
  h.tasks[0].status = 'pending'; h.save();
  const other = harness(t, 'other', h);
  await other.events.get('session_start')({}, other.ctx);
  assert.equal(h.store.load().stopping.length, 1);
  await runtime.events.get('session_start')({}, runtime.ctx);
  await new Promise(setImmediate);
  assert.equal(h.store.load().stopping.length, 0);
  assert.equal(h.store.load().paused.length, 1);
  assert.equal(runtime.statuses.at(-1)[1], 'Companion · 1 report');
  await other.command('start');
  assert.equal(other.messages.length, 1);
});

test('failed session recovery reports the pending stop and preserves its footer', async t => {
  const h = schedulerFixture(t); h.tasks[0].status = 'running'; h.save();
  const runtime = harness(t, 'owner', h);
  Object.assign(runtime.pi, { getCommands: h.pi.getCommands, sendUserMessage: h.pi.sendUserMessage });
  await runtime.ingest(report('failed-recovery'));
  const stopping = runtime.command('stop');
  await runtime.events.get('session_shutdown')({}, runtime.ctx);
  await stopping;
  await new Promise(setImmediate);
  h.tasks[0].status = 'pending'; h.save();
  runtime.pi.getCommands = () => [];
  let notify;
  const notified = new Promise(resolve => { notify = resolve; });
  runtime.ctx.ui.notify = (...args) => notify(args);
  await runtime.events.get('session_start')({}, runtime.ctx);
  const [message] = await notified;
  assert.match(message, /stop remains pending/);
  assert.equal(h.store.load().stopping.length, 1);
  assert.equal(runtime.statuses.at(-1)[1], 'Companion · 1 report');
});

test('immediate shutdown/start chains recovery after the interrupted control clears', async t => {
  const h = schedulerFixture(t); h.tasks[0].status = 'running'; h.save();
  const runtime = harness(t, 'owner', h);
  Object.assign(runtime.pi, { getCommands: h.pi.getCommands, sendUserMessage: h.pi.sendUserMessage });
  const stopping = runtime.command('stop');
  assert.equal(h.store.load().stopping.length, 1);
  await runtime.events.get('session_shutdown')({}, runtime.ctx);
  await runtime.events.get('session_start')({}, runtime.ctx);
  h.tasks[0].status = 'pending'; h.save();
  await stopping;
  await new Promise(setImmediate);
  assert.deepEqual(h.sent, ['/schedule-disable task_owned']);
  assert.equal(h.tasks[0].enabled, false);
  assert.equal(h.store.load().stopping.length, 0); assert.equal(h.store.load().paused.length, 1);
});

test('start resumes saved schedules before sending bundled instructions', async t => {
  const h = schedulerFixture(t);
  await controlSchedules('stop', h.pi, h.ctx, h.store, h.options);
  const runtime = harness(t, 'owner', h), sequence = [], dispatch = h.pi.sendUserMessage;
  runtime.pi.getCommands = h.pi.getCommands;
  runtime.pi.sendUserMessage = (content, options) => {
    sequence.push(content);
    if (content === companionInstructions) runtime.messages.push({ content, options });
    else dispatch(content, options);
  };
  await runtime.command('start');
  assert.deepEqual(sequence, ['/schedule-enable task_owned', companionInstructions]);
  assert.equal(h.store.load().paused.length, 0);
  assert.deepEqual(runtime.messages, [{ content: companionInstructions, options: { deliverAs: 'followUp' } }]);
});

test('a delivery racing the disable command cannot re-enable the stopped schedule', async t => {
  const h = schedulerFixture(t), dispatch = h.pi.sendUserMessage;
  h.pi.sendUserMessage = (command, options) => {
    dispatch(command, options);
    if (h.sent.length !== 1) return;
    h.tasks[0].runOwner = { attemptId: 'in-flight' }; h.save();
    queueMicrotask(() => { delete h.tasks[0].runOwner; Object.assign(h.tasks[0], { enabled: true, status: 'pending', runCount: 1 }); h.save(); });
  };
  await controlSchedules('stop', h.pi, h.ctx, h.store, h.options);
  assert.deepEqual(h.sent, ['/schedule-disable task_owned', '/schedule-disable task_owned']);
  assert.equal(h.tasks[0].enabled, false); assert.equal(h.store.load().paused.length, 1);
});

test('start never resurrects cancelled, edited, manually re-disabled or no-longer-approved work', async t => {
  const h = schedulerFixture(t);
  for (const change of [task => task.status = 'cancelled', task => task.schedule = 'changed', task => task.disabledAt = 'manually-stopped', task => task.name = 'Removed', task => task.prompt = 'Different work']) {
    Object.assign(h.tasks[0], { name: 'Reading', status: 'pending', enabled: true, schedule: '0 9 * * 5' }); h.save();
    await controlSchedules('stop', h.pi, h.ctx, h.store, h.options);
    change(h.tasks[0]); h.save(); const count = h.sent.length;
    await controlSchedules('start', h.pi, h.ctx, h.store, h.options);
    assert.equal(h.sent.length, count);
  }
});

test('switching session while a view is open cannot consume the old result', async t => {
  const h = harness(t); await h.ingest(update());
  h.ctx.ui.select = async (_title, choices) => choices[0];
  h.ctx.ui.custom = async () => { await h.events.get('session_shutdown')({}, h.ctx); return true; };
  await h.command('updates');
  assert.equal(new Store(h.dir, 'owner').load().items[0].readAt, undefined);
});

test('aborted ingestion and write failure cannot advertise a saved result', async t => {
  const h = harness(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(h.tools.get('companion_save').execute('call', report(), controller.signal, undefined, h.ctx));
  assert.equal(h.statuses.length, 0);
  writeFileSync(new Store(h.dir, 'owner').file, '{broken');
  await assert.rejects(h.ingest(report()));
  assert.equal(h.statuses.length, 0);
});

test('unconfirmed scheduler dispatch times out rather than recording a successful stop', async t => {
  const h = schedulerFixture(t); h.pi.sendUserMessage = () => {};
  await assert.rejects(controlSchedules('stop', h.pi, h.ctx, h.store, h.options), /did not confirm/);
  assert.equal(h.store.load().paused.length, 0);
});

test('scheduler failure is not acknowledged as stopped and missing scheduler fails clearly', async t => {
  const h = schedulerFixture(t);
  h.pi.sendUserMessage = () => { throw Error('dispatch failed'); };
  await assert.rejects(controlSchedules('stop', h.pi, h.ctx, h.store, h.options), /dispatch failed/);
  assert.equal(h.store.load().paused.length, 0);
  h.pi.getCommands = () => [];
  await assert.rejects(controlSchedules('stop', h.pi, h.ctx, h.store, h.options), /scheduler/i);
});
