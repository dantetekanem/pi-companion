import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Use Pi's already installed loader and bundled peers; never install during tests.
const root = process.env.PI_PACKAGE_ROOT || resolve(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')), '../..');
const require = createRequire(join(root, 'package.json'));
const { createJiti } = require('jiti');
const host = createJiti(join(root, 'package.json'));
const aliases = Object.fromEntries(['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', '@earendil-works/pi-ai', 'typebox/value', 'typebox']
  .map(name => [name, fileURLToPath(host.esmResolve(name))]));
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: aliases });
const { Store } = await jiti.import('../src/store.ts');
const { label, validateResult } = await jiti.import('../src/result.ts');
const { controlSchedules } = await jiti.import('../src/scheduler.ts');
const { registerCompanion } = await jiti.import('../src/index.ts');
const tasteInstructions = readFileSync(new URL('../src/prompts/taste.md', import.meta.url), 'utf8');
const companionInstructions = [readFileSync(new URL('../src/prompts/prompt.md', import.meta.url), 'utf8'), tasteInstructions].join('\n\n');
const report = (id = 'digest-1', outcome = 'no_change') => ({
  id, kind: 'report', final: true, title: 'Reading', body: 'Useful result with evidence.',
  checks: [{ source: 'Paper source', outcome, detail: 'Checked the current listing.' }],
});
const update = (id = 'update-1') => ({ ...report(id, 'findings'), kind: 'update', reason: 'action', title: 'Review a breaking change' });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'companion-test-'));
  const shutdowns = [];
  t.after(async () => {
    for (const shutdown of shutdowns) await shutdown();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, shutdowns, store: new Store(dir, 'owner') };
}

test('installed Pi loader discovers the real extension without starting a session', async t => {
  const { dir } = fixture(t);
  const { loadExtensions } = await import(join(root, 'dist/core/extensions/loader.js'));
  const loaded = await loadExtensions([fileURLToPath(new URL('../src/index.ts', import.meta.url))], dir);
  assert.deepEqual(loaded.errors, []);
  assert.ok(loaded.extensions[0].commands.has('companion'));
});

test('save survives a new store instance; opening is not reading; explicit read persists', t => {
  const { dir, store } = fixture(t);
  store.ingest(update()); store.ingest(report());
  assert.equal(new Store(dir, 'owner').load().items.length, 2);
  store.load();
  assert.equal(store.load().items[0].readAt, undefined);
  store.markRead('update-1');
  assert.ok(new Store(dir, 'owner').load().items[0].readAt);
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
  assert.throws(() => validateResult({ ...report(), kind: 'update', reason: 'material' }), /finding/);
  assert.throws(() => validateResult({ ...report(), final: false }), /Invalid/);
  assert.throws(() => validateResult({ ...report(), checks: [] }), /Invalid/);
});

test('explicit incomplete blocker can be an update, without claiming collection succeeded', t => {
  const { store } = fixture(t);
  store.ingest({ ...report('blocker', 'failed'), kind: 'update', reason: 'blocker' });
  assert.match(label(store.load().items[0]), /incomplete/);
});

test('invalid input, unsafe terminal controls and malformed storage fail closed', t => {
  const { store } = fixture(t);
  for (const patch of [{ title: '\u001b[31munsafe' }, { title: 'Trailing newline\n' }, { id: 'id\n' }, { body: 'x'.repeat(33000) }, { sessionId: 'other' }, { title: '   ' }, { body: ' \n\t' }]) {
    assert.throws(() => store.ingest({ ...report(), ...patch }));
  }
  store.ingest({ ...report(), body: 'Useful result\nwith evidence.' });
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
  const options = { root: fixturePaths.dir, locationRoot: fixturePaths.dir, schedulerFile: join(fixturePaths.dir, 'tasks.json'), schedulesFile: join(fixturePaths.dir, 'schedules.md'), reportsFile: join(fixturePaths.dir, 'reports.md'), reviewSettingsFile: join(fixturePaths.dir, 'teams.json') };
  fixturePaths.tasks ??= [];
  const events = new Map(), tools = new Map(), commands = new Map(), notices = [], selections = [];
  const ctx = { mode: 'tui', hasUI: true, isIdle: () => true, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => `${sessionId}.jsonl`, getLeafId: () => 'leaf' },
    ui: { notify: (...args) => notices.push(args),
      select: async (title, choices) => { selections.push({ title, choices }); return undefined; }, custom: async () => false } };
  const messages = [], pi = { on: (name, fn) => events.set(name, fn), registerTool: tool => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    getCommands: () => ['schedule', 'schedule-enable', 'schedule-disable'].map(name => ({ name, sourceInfo: { path: '/test/@jl1990/pi-scheduler/index.ts' } })),
    exec: async () => ({ code: 1, stdout: '', stderr: 'Herdr unavailable', killed: false }),
    sendUserMessage: (content, delivery) => {
      if (!delivery?.expandPromptTemplates) { messages.push({ content, options: delivery }); return; }
      const tasks = fixturePaths.tasks ?? [];
      if (content.startsWith('/schedule ')) tasks.push({ id: `task_daily_${sessionId}`, action: 'prompt', type: 'interval', schedule: '24h',
        prompt: content.split(' :: ')[1], scope: 'session', sessionFile: `${sessionId}.jsonl`, enabled: true, status: 'pending' });
      else {
        const [command, id] = content.split(' '), task = tasks.find(item => item.id === id);
        task.enabled = command === '/schedule-enable';
        if (!task.enabled) task.disabledAt = new Date().toISOString();
      }
      fixturePaths.tasks = tasks;
      writeFileSync(options.schedulerFile, JSON.stringify({ tasks }));
    } };
  registerCompanion(pi, options);
  fixturePaths.shutdowns.push(() => events.get('session_shutdown')({}, ctx));
  return { ...fixturePaths, pi, ctx, options, events, tools, commands, notices, selections, messages,
    command: args => commands.get('companion').handler(args, ctx),
    ingest: params => new Store(fixturePaths.dir, sessionId).ingest(params) };
}

test('legacy reload migrates proven activity but preserves paused, stopping and ambiguous sessions', async t => {
  for (const mode of ['active', 'paused', 'stopping', 'ambiguous']) {
    const h = schedulerFixture(t), runtime = harness(t, 'owner', h);
    const state = h.store.load();
    state.started = true;
    if (mode === 'paused') state.paused.push({ id: 'task_owned', signature: 'legacy', disabledAt: 'before' });
    if (mode === 'stopping') state.stopping.push({ id: 'task_owned', signature: 'legacy' });
    if (mode === 'ambiguous') { h.tasks[0].enabled = false; h.save(); }
    h.store.save(state);
    await runtime.events.get('session_start')({}, runtime.ctx);
    assert.equal(h.store.load().experience.enabled, mode === 'active');
    const context = await runtime.events.get('before_agent_start')({}, runtime.ctx);
    assert.match(context.message.content, mode === 'active' ? /Companion is running/ : /Companion is stopped/);
  }
});

test('stopped state is durable even when scheduler control fails', async t => {
  const h = harness(t);
  await h.command('start');
  await h.command('stop');
  assert.equal(new Store(h.dir, 'owner').load().experience.enabled, false);
});

test('stopped Companion blocks queued resumption of owned tasks but preserves unrelated schedules', async t => {
  const h = schedulerFixture(t), runtime = harness(t, 'owner', h);
  await runtime.command('stop');
  const gate = runtime.events.get('tool_call');
  assert.equal((await gate({ toolName: 'schedule_task', input: { name: 'Reading' } }, runtime.ctx)).block, true);
  assert.equal((await gate({ toolName: 'manage_scheduled_task', input: { action: 'enable', id: 'task_owned' } }, runtime.ctx)).block, true);
  assert.equal(await gate({ toolName: 'manage_scheduled_task', input: { action: 'enable', id: 'task_other' } }, runtime.ctx), undefined);
  assert.equal(await gate({ toolName: 'schedule_task', input: { name: 'CI poll' } }, runtime.ctx), undefined);
});

test('cold setup sends instructions once; repeated starts restore the saved runtime without model work', async t => {
  const h = harness(t), command = h.commands.get('companion');
  assert.deepEqual(command.getArgumentCompletions('')?.map(item => item.value), ['start', 'stop']);
  assert.deepEqual(command.getArgumentCompletions('sta')?.map(item => item.value), ['start']);
  assert.equal(command.getArgumentCompletions('missing'), null);
  await h.command('start'); await h.command('');
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].content, companionInstructions);
  assert.equal(h.notices.some(([message]) => /failed|required/i.test(message)), false);
  await h.events.get('session_shutdown')({}, h.ctx);
  const reopened = harness(t, 'owner', h);
  await reopened.command('start');
  assert.deepEqual(reopened.messages, []);
  assert.equal(new Store(h.dir, 'owner').load().experience.enabled, true);
  assert.equal(h.selections.length, 0);
});

test('shutdown before checkpoint admission prevents stale start effects and releases ownership', async t => {
  const h = harness(t), starting = h.command('start');
  await h.events.get('session_shutdown')({}, h.ctx);
  await starting;
  assert.equal(new Store(h.dir, 'owner').load().started, undefined);
  const resumed = harness(t, 'owner', h);
  await resumed.command('start');
  assert.equal(new Store(h.dir, 'owner').load().experience.enabled, true);
  assert.equal(resumed.messages.length, 1);
});

test('a registry alone cannot bind a fresh conversation and reconstruct its routines', async t => {
  const h = harness(t);
  writeFileSync(h.options.schedulesFile, '# Schedules\n## Reading\n');
  await h.command('start');
  assert.ok(h.notices.some(([message]) => /existing Companion session/.test(message)));
  assert.equal(new Store(h.dir, 'owner').load().started, undefined);
  assert.equal(h.messages.length, 0);
});

function locationHarness(t, h = harness(t)) {
  for (const [key, value] of Object.entries({ HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w1', HERDR_PANE_ID: 'w1:p2' })) {
    const previous = process.env[key]; process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const pane = { pane_id: 'w1:p1', workspace_id: 'w1' }, calls = [];
  h.pi.exec = async (command, args, options) => {
    calls.push(args); assert.equal(command, 'herdr'); assert.equal(options.timeout, 1000);
    assert.deepEqual(args, ['pane', 'current', '--current']);
    return { code: 0, stdout: JSON.stringify({ result: { pane } }), killed: false };
  };
  const file = join(h.dir, `pi-companion-${process.getuid?.() ?? 'user'}-w1.json`);
  return { ...h, pane, calls, file };
}

test('Companion location saved by start is automatically injected once in a new agent without discovery', async t => {
  const h = locationHarness(t); await h.command('start');
  assert.deepEqual(JSON.parse(readFileSync(h.file, 'utf8')), { workspace: 'w1', pane: 'w1:p1' });
  assert.equal(statSync(h.file).mode & 0o777, 0o600);
  assert.equal(h.messages[0].content, companionInstructions);
  const reader = harness(t, 'reader', h), calls = [];
  reader.pi.exec = async (...args) => { calls.push(args); throw Error('No discovery allowed'); };
  const notice = () => reader.events.get('before_agent_start')({}, reader.ctx);
  assert.deepEqual(await notice(), { message: { customType: 'companion-tail', display: false,
    content: `${readFileSync(new URL('../src/prompts/tail.md', import.meta.url), 'utf8')}\nCompanion location: pane w1:p1 (workspace w1)` } });
  assert.equal(await notice(), undefined);
  await reader.events.get('session_start')({}, reader.ctx);
  assert.ok((await notice())?.message);
  assert.equal(calls.length, 0); assert.equal(reader.messages.length, 0);
  h.pane.pane_id = 'w1:p3'; await h.command('start');
  await reader.events.get('session_start')({}, reader.ctx);
  assert.ok((await notice())?.message.content.endsWith('pane w1:p3 (workspace w1)'));
});

test('Companion location excludes self, other workspaces, missing and malformed records', async t => {
  const h = locationHarness(t); await h.command('start');
  const saved = readFileSync(h.file, 'utf8');
  for (const data of ['{broken', '{}', JSON.stringify({ workspace: 'w2', pane: 'w2:p1' }),
    JSON.stringify({ workspace: 'w1', pane: 'w1:p2' }),
    JSON.stringify({ workspace: 'w1', pane: '' })]) {
    writeFileSync(h.file, data);
    const reader = harness(t, 'reader', h);
    assert.equal(await reader.events.get('before_agent_start')({}, reader.ctx), undefined);
  }
  writeFileSync(h.file, saved); process.env.HERDR_ENV = '0';
  const outside = harness(t, 'reader', h);
  assert.equal(await outside.events.get('before_agent_start')({}, outside.ctx), undefined);
  process.env.HERDR_ENV = '1'; rmSync(h.file);
  const missing = harness(t, 'reader', h);
  assert.equal(await missing.events.get('before_agent_start')({}, missing.ctx), undefined);
});

test('Companion location failures do not block start and stale start cannot register', async t => {
  const h = locationHarness(t);
  for (const result of [{ code: 1, stdout: '{}' }, { code: 0, stdout: '{broken' },
    { code: 0, stdout: '{"result":{"pane":{"pane_id":"","workspace_id":"w1"}}}' }]) {
    h.pi.exec = async () => result; await h.command('start');
    assert.throws(() => statSync(h.file), { code: 'ENOENT' });
  }
  assert.equal(h.messages.length, 1);
  let release, entered;
  const executing = new Promise(resolve => { entered = resolve; });
  h.pi.exec = () => new Promise(resolve => { release = resolve; entered(); });
  const starting = h.command('start');
  await executing;
  await h.events.get('session_shutdown')({}, h.ctx);
  release({ code: 0, stdout: JSON.stringify({ result: { pane: h.pane } }) });
  await starting;
  assert.throws(() => statSync(h.file), { code: 'ENOENT' });
});

test('a new session resumes the Durable owner instead of creating another set of routines', async t => {
  const scheduler = schedulerFixture(t), first = harness(t, 'owner', scheduler);
  scheduler.store.save({ ...scheduler.store.load(), started: true });
  await first.command('start');
  assert.deepEqual(first.messages, []);
  const second = harness(t, 'other', scheduler);
  await second.command('start');
  assert.ok(second.notices.some(([message]) => /already running/.test(message)));
  await first.events.get('session_shutdown')({}, first.ctx);
  const resumed = harness(t, 'owner', scheduler), switched = [];
  resumed.ctx.sendUserMessage = async (command, options) => {
    assert.equal(command, '/companion start');
    assert.equal(options.expandPromptTemplates, true);
    await resumed.command('start');
  };
  second.ctx.switchSession = async (file, { withSession }) => {
    switched.push(file);
    await second.events.get('session_shutdown')({}, second.ctx);
    await withSession(resumed.ctx);
    return { cancelled: false };
  };
  await second.command('start');
  assert.deepEqual(switched, ['owner.jsonl']);
  assert.deepEqual(second.messages, []);
  assert.deepEqual(resumed.messages, []);
  assert.equal(scheduler.tasks.filter(task => task.name === 'Reading' && task.sessionFile === 'other.jsonl').length, 1);
  assert.equal(scheduler.tasks.find(task => task.id === 'task_other').enabled, true);
  await second.command('stop');
  assert.equal(scheduler.tasks.find(task => task.id === 'task_other').enabled, true);
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

function schedulerFixture(t) {
  const { dir, store, shutdowns } = fixture(t);
  const schedulerFile = join(dir, 'tasks.json'), schedulesFile = join(dir, 'schedules.md');
  writeFileSync(schedulesFile, '# Schedules\n## Reading\n## Mail\n');
  const task = (id, patch = {}) => ({ id, name: 'Reading', scope: 'session', sessionFile: 'owner.jsonl', type: 'cron', schedule: '0 9 * * 5', status: 'pending', enabled: true, ...patch });
  const tasks = [task('task_owned'), task('task_other', { sessionFile: 'other.jsonl' }), task('task_global', { scope: 'global' }),
    task('task_finance', { name: 'Finance updates' }), task('task_cancelled', { enabled: false, status: 'cancelled' }),
    task('task_manual', { enabled: false }), task('task_once', { type: 'once' }), task('task_unrelated', { name: 'CI poll' }),
    task('task_suffix', { name: 'Reading (other work)' })];
  const save = () => writeFileSync(schedulerFile, JSON.stringify({ tasks })); save();
  const sent = [], pi = {
    getCommands: () => ['schedule', 'schedule-enable', 'schedule-disable'].map(name => ({ name, sourceInfo: { path: '/test/@jl1990/pi-scheduler/extensions/scheduler/index.ts' } })),
    sendUserMessage: (command, options) => {
      sent.push(command); assert.equal(options.expandPromptTemplates, true);
      const [verb, id] = command.split(' ');
      if (verb === '/schedule') {
        tasks.push({ id: 'task_daily_owner', action: 'prompt', type: 'interval', schedule: '24h', prompt: command.split(' :: ')[1],
          scope: 'session', sessionFile: 'owner.jsonl', enabled: true, status: 'pending' });
      } else {
        const item = tasks.find(task => task.id === id);
        item.enabled = verb === '/schedule-enable'; if (!item.enabled) item.disabledAt = `paused-${sent.length}`;
      }
      save();
    },
  };
  return { dir, store, shutdowns, tasks, save, sent, pi, options: { schedulerFile, schedulesFile }, ctx: { sessionManager: { getSessionFile: () => 'owner.jsonl' } } };
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

for (const change of ['removed', 'changed']) {
  test(`stop pauses owned routines when the daily wake was ${change}, retaining its failure across reload`, async t => {
    const scheduler = schedulerFixture(t);
    const runtime = harness(t, 'owner', scheduler);
    Object.assign(runtime.pi, scheduler.pi);
    await runtime.command('start');
    const wake = scheduler.store.load().experience.wake;
    const daily = scheduler.tasks.find(task => task.id === wake.schedulerId);
    assert.ok(daily);
    if (change === 'removed') scheduler.tasks.splice(scheduler.tasks.indexOf(daily), 1);
    else daily.schedule = '12h';
    scheduler.save();

    await runtime.command('stop');

    const stopped = scheduler.store.load();
    assert.equal(stopped.experience.enabled, false);
    assert.equal(stopped.experience.wake.schedulerId, daily.id);
    assert.equal(stopped.experience.wake.pausedAt, undefined);
    assert.deepEqual(stopped.paused.map(receipt => receipt.id), ['task_owned']);
    assert.deepEqual(stopped.stopping, []);
    assert.equal(scheduler.tasks.find(task => task.id === 'task_owned').enabled, false);
    assert.equal(scheduler.tasks.find(task => task.id === 'task_other').enabled, true);
    assert.ok(runtime.notices.some(([message, level]) => level === 'error' && /daily schedule.*changed/.test(message)));

    await runtime.events.get('session_shutdown')({}, runtime.ctx);
    const reopened = harness(t, 'owner', scheduler);
    Object.assign(reopened.pi, scheduler.pi);
    await reopened.events.get('session_start')({}, reopened.ctx);
    assert.ok(reopened.notices.some(([message, level]) => level === 'error' && /daily schedule.*changed/.test(message)));
    assert.equal(scheduler.sent.filter(command => command === '/schedule-disable task_owned').length, 1);
    assert.deepEqual(scheduler.store.load().paused.map(receipt => receipt.id), ['task_owned']);

    // Restoring the original wake lets an explicit retry settle its pending stop.
    if (change === 'removed') scheduler.tasks.push(daily);
    else daily.schedule = '24h';
    scheduler.save();
    reopened.notices.length = 0;
    await reopened.command('stop');
    assert.equal(reopened.notices.some(([, level]) => level === 'error'), false);
    assert.equal(daily.enabled, false);
    assert.ok(scheduler.store.load().experience.wake.pausedAt);
    assert.equal(scheduler.sent.filter(command => command === '/schedule-disable task_owned').length, 1);
  });
}

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

function stopRequested(runtime) {
  return new Promise(resolve => {
    const notify = runtime.ctx.ui.notify;
    runtime.ctx.ui.notify = (...args) => {
      notify(...args);
      if (args[0].includes('stop requested')) resolve();
    };
  });
}

test('successful session recovery completes the stop and preserves saved results', async t => {
  const h = schedulerFixture(t); h.tasks[0].status = 'running'; h.save();
  const runtime = harness(t, 'owner', h);
  Object.assign(runtime.pi, { getCommands: h.pi.getCommands, sendUserMessage: h.pi.sendUserMessage });
  await runtime.command('start');
  await runtime.ingest(report('recovery-history'));
  const requested = stopRequested(runtime), stopping = runtime.command('stop');
  await requested;
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
  await other.command('start');
  assert.equal(other.messages.length, 0);
  assert.ok(other.notices.some(([message]) => /already running/.test(message)));
});

test('failed session recovery reports the pending stop and retains its receipt', async t => {
  const h = schedulerFixture(t); h.tasks[0].status = 'running'; h.save();
  const runtime = harness(t, 'owner', h);
  Object.assign(runtime.pi, { getCommands: h.pi.getCommands, sendUserMessage: h.pi.sendUserMessage });
  await runtime.command('start');
  await runtime.ingest(report('failed-recovery'));
  const requested = stopRequested(runtime), stopping = runtime.command('stop');
  await requested;
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
  assert.match(message, /recovery:.*scheduler command is required|stop remains pending/i);
  assert.equal(h.store.load().stopping.length, 1);
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

test('adopting an existing Companion resumes its saved schedules without rebuilding setup', async t => {
  const h = schedulerFixture(t);
  h.store.save({ ...h.store.load(), started: true });
  await controlSchedules('stop', h.pi, h.ctx, h.store, h.options);
  const runtime = harness(t, 'owner', h), sequence = [], dispatch = h.pi.sendUserMessage;
  runtime.pi.getCommands = h.pi.getCommands;
  runtime.pi.sendUserMessage = (content, options) => {
    sequence.push(content);
    if (content === companionInstructions) runtime.messages.push({ content, options });
    else dispatch(content, options);
  };
  await runtime.command('start');
  assert.ok(sequence.some(text => text.startsWith('/schedule prompt interval 24h')));
  assert.ok(sequence.includes('/schedule-enable task_owned'));
  assert.equal(h.store.load().paused.length, 0);
  assert.deepEqual(runtime.messages, []);
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
