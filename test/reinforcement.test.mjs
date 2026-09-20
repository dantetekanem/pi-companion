import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = process.env.PI_PACKAGE_ROOT || resolve(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')), '../..');
const require = createRequire(join(root, 'package.json'));
const { createJiti } = require('jiti');
const host = createJiti(join(root, 'package.json'));
const alias = Object.fromEntries(['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai', 'typebox', 'typebox/value'].map(name => [name, fileURLToPath(host.esmResolve(name))]));
const jiti = createJiti(import.meta.url, { alias });
const { ExperienceStore, recordEvidence, view } = await jiti.import('../src/experience.ts');
const { review } = await jiti.import('../src/reflection.ts');
const emptyReview = () => ({ assessments: [], lessons: [], decisions: [], answers: [] });
const response = data => ({ stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(data) }], usage: { cost: { total: 0.02 } } });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'companion-reinforcement-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const settings = join(dir, 'teams.json');
  writeFileSync(settings, JSON.stringify({ favoriteModels: { 'read-critical': { model: 'openai-codex/strong', thinking: 'max' } } }));
  const model = { id: 'strong', name: 'Fixture', provider: 'openai-codex', api: 'openai-codex-responses', reasoning: true, thinkingLevelMap: { max: 'xhigh' } };
  const calls = [];
  let result = response(emptyReview());
  const ctx = { model: { provider: 'openai-codex', id: 'conversation' }, modelRegistry: {
    find: (provider, id) => provider === model.provider && id === model.id ? model : undefined,
    complete: async (...args) => { calls.push(args); return result; },
  } };
  const store = new ExperienceStore(dir, 'owner');
  store.update(state => {
    state.enabled = true;
    recordEvidence(state, { id: 'answer', kind: 'user', text: 'Friday afternoons are useful.', provider: 'openai-codex' });
  });
  return { dir, settings, model, calls, ctx, store, setResult(value) { result = value; } };
}

test('daily reflection actually calls the configured critical binding and curates evidence for the next decision', async t => {
  const h = fixture(t);
  h.setResult(response({ ...emptyReview(), lessons: [{ id: 'weekly-time', action: 'upsert', text: 'Try weekly work on Friday afternoon.', confidence: 'supported', evidenceIds: ['answer'] }] }));
  assert.equal(await review(h.store, h.ctx, h.settings, new AbortController().signal), true);
  const [model, context, options] = h.calls[0];
  assert.equal(model, h.model);
  assert.equal(context.tools, undefined);
  assert.match(context.messages[0].content, /Friday afternoons/);
  assert.equal(options.reasoningEffort, 'max');
  assert.equal(options.reasoning, undefined);
  assert.equal(options.cacheRetention, 'none');
  assert.equal(h.ctx.model.id, 'conversation');
  assert.equal(view(h.store.load()).lessons[0].id, 'weekly-time');
  assert.equal(h.store.load().reviews[0].status, 'completed');
  assert.equal(h.store.load().reviews[0].cost, 0.02);
  assert.equal(await review(h.store, h.ctx, h.settings, new AbortController().signal), false);
  assert.equal(h.calls.length, 1);
});

test('missing binding, unsupported max and a different provider fail without a downgraded call', async t => {
  for (const fault of ['missing', 'effort', 'provider']) {
    const h = fixture(t);
    if (fault === 'missing') writeFileSync(h.settings, '{}');
    if (fault === 'effort') h.model.thinkingLevelMap = {};
    if (fault === 'provider') h.ctx.model.provider = 'another-provider';
    await assert.rejects(review(h.store, h.ctx, h.settings, new AbortController().signal));
    assert.equal(h.calls.length, 0);
    assert.equal(h.store.load().reviews[0].status, 'failed');
  }
});

test('failed, truncated and unsupported-evidence responses never become learned facts', async t => {
  const invalid = response({ ...emptyReview(), lessons: [{ id: 'fake', action: 'upsert', text: 'Unsupported.', confidence: 'supported', evidenceIds: ['missing'] }] });
  for (const result of [{ ...response(emptyReview()), stopReason: 'length' }, { stopReason: 'error', errorMessage: 'Authentication failed', content: [] }, invalid]) {
    const h = fixture(t);
    h.setResult(result);
    await assert.rejects(review(h.store, h.ctx, h.settings, new AbortController().signal));
    assert.equal(view(h.store.load()).lessons.length, 0);
    assert.equal(h.store.load().reviews[0].status, 'failed');
    assert.equal(await review(h.store, h.ctx, h.settings, new AbortController().signal), false);
    assert.equal(h.calls.length, 1);
  }
});

test('oversized model output is rejected before it can become learning', async t => {
  const h = fixture(t);
  h.setResult(response('x'.repeat(32001)));
  await assert.rejects(review(h.store, h.ctx, h.settings, new AbortController().signal), /oversized output/);
  assert.equal(h.store.load().reviews[0].status, 'failed');
  assert.equal(h.store.load().lessons.length, 0);
});

test('stop rejects a late review and an abort settles even if the provider does not cooperate', async t => {
  const h = fixture(t);
  let resolve;
  h.ctx.modelRegistry.complete = () => new Promise(done => { resolve = done; });
  const controller = new AbortController();
  const pending = review(h.store, h.ctx, h.settings, controller.signal);
  h.store.update(state => { state.enabled = false; state.generation++; });
  controller.abort(new Error('Stopped'));
  await assert.rejects(pending, /Stopped|abort/i);
  resolve(response({ ...emptyReview(), lessons: [{ id: 'late', action: 'upsert', text: 'Late result.', confidence: 'supported', evidenceIds: ['answer'] }] }));
  await new Promise(setImmediate);
  assert.equal(h.store.load().lessons.length, 0);
  assert.equal(h.store.load().reviews[0].status, 'failed');
});

async function runtimeFixture(t) {
  const h = fixture(t);
  const { registerReinforcement } = await jiti.import('../src/reinforcement.ts');
  const tasks = [], messages = [], events = new Map(), tools = new Map(), notices = [];
  const paths = { root: h.dir, schedulerFile: join(h.dir, 'scheduler.json'), schedulesFile: join(h.dir, 'schedules.md'),
    reportsFile: join(h.dir, 'reports.md'), reviewSettingsFile: h.settings };
  const save = () => writeFileSync(paths.schedulerFile, JSON.stringify({ tasks }));
  writeFileSync(paths.schedulesFile, '# Tasks\n## Reading\n');
  save();
  let idle = true, count = 0;
  const ctx = { ...h.ctx, cwd: h.dir, hasUI: true, isIdle: () => idle,
    sessionManager: { getSessionId: () => 'owner', getSessionFile: () => 'owner.jsonl', getLeafId: () => 'leaf-1' },
    ui: { notify: (...args) => notices.push(args) } };
  const pi = {
    on: (name, fn) => events.set(name, fn), registerTool: tool => tools.set(tool.name, tool), registerCommand() {},
    getCommands: () => ['schedule', 'schedule-enable', 'schedule-disable'].map(name => ({ name, sourceInfo: { path: '/test/@jl1990/pi-scheduler/index.ts' } })),
    sendUserMessage(text, options) {
      if (!options?.expandPromptTemplates) { messages.push(text); return; }
      const [command, ...args] = text.split(' ');
      if (command === '/schedule') tasks.push({ id: `task_${++count}`, action: 'prompt', type: 'interval', schedule: args[2],
        prompt: text.split(' :: ')[1], scope: 'session', sessionFile: 'owner.jsonl', enabled: true, status: 'pending' });
      else {
        const task = tasks.find(item => item.id === args[0]);
        task.enabled = command === '/schedule-enable';
        if (!task.enabled) task.disabledAt = `disabled-${++count}`;
      }
      save();
    },
  };
  const runtime = registerReinforcement(pi, paths);
  const fire = task => `[Scheduled task ${task.id} fired]\nName: ${task.name ?? '(unnamed)'}\nAction: prompt\nType: ${task.type}\nSchedule: ${task.schedule}\nScheduled for: ${new Date(Date.now() - 1000).toISOString()}\n${task.prompt}`;
  return { ...h, pi, paths, tasks, messages, events, tools, ctx, runtime, notices, save, fire, setIdle(value) { idle = value; } };
}

test('start creates one daily wake, busy delivery waits for settlement, and learned context reaches the actor', async t => {
  const h = await runtimeFixture(t);
  h.setResult(response({ ...emptyReview(), lessons: [{ id: 'timing', action: 'upsert', text: 'Use Friday afternoon for weekly planning.', confidence: 'supported', evidenceIds: ['answer'] }] }));
  await h.runtime.start(h.ctx);
  await h.runtime.start(h.ctx);
  assert.equal(h.tasks.length, 1);
  assert.equal(h.tasks[0].schedule, '24h');
  h.setIdle(false);
  const wake = { source: 'extension', text: h.fire(h.tasks[0]) };
  assert.deepEqual(await h.events.get('input')(wake, h.ctx), { action: 'handled' });
  assert.equal(h.calls.length, 0);
  h.setIdle(true);
  await h.events.get('agent_settled')({}, h.ctx);
  assert.equal(h.calls.length, 1);
  assert.match(h.runtime.context(h.ctx), /Use Friday afternoon/);
  await h.events.get('input')(wake, h.ctx);
  assert.equal(h.calls.length, 1);
  await h.runtime.stop(h.ctx);
  assert.equal(h.tasks[0].enabled, false);
  await h.events.get('input')(wake, h.ctx);
  assert.equal(h.calls.length, 1);
  assert.equal(await h.events.get('input')({ source: 'extension', text: '[Scheduled task manual fired]\nNotes about companion-daily:example' }, h.ctx), undefined);
});

test('the agent can publish a question and a normal user answer is captured without manual feedback commands', async t => {
  const h = await runtimeFixture(t);
  await h.runtime.start(h.ctx);
  await h.tools.get('companion_record').execute('q-call', { kind: 'question', id: 'timing', text: 'When should the weekly check happen?', evidenceIds: [] }, undefined, undefined, h.ctx);
  assert.match(readFileSync(h.paths.reportsFile, 'utf8'), /When should the weekly check happen/);
  await h.events.get('input')({ source: 'interactive', text: 'Friday afternoons, please.' }, h.ctx);
  const answer = h.store.load().evidence.find(item => item.kind === 'user' && item.text === 'Friday afternoons, please.');
  assert.ok(answer);
  h.setResult(response({ ...emptyReview(), answers: [{ questionId: 'timing', evidenceIds: [answer.id] }] }));
  await h.events.get('input')({ source: 'extension', text: h.fire(h.tasks[0]) }, h.ctx);
  assert.equal(h.store.load().questions[0].status, 'answered');
  assert.deepEqual(h.store.load().questions[0].answerIds, [answer.id]);
});

test('scheduler receipts and task deliveries are observed without claiming a finished task or swallowing work', async t => {
  const h = await runtimeFixture(t);
  await h.runtime.start(h.ctx);
  const task = { id: 'task_reading', name: 'Reading', action: 'prompt', type: 'interval', schedule: '1d', prompt: 'Read current instructions.',
    scope: 'session', sessionFile: 'owner.jsonl', enabled: true, status: 'pending' };
  h.tasks.push(task);
  h.save();
  await h.events.get('tool_result')({ toolName: 'schedule_task', toolCallId: 'create-reading', input: { name: 'Reading' }, isError: false, details: { task } }, h.ctx);
  const message = { source: 'extension', text: h.fire(task) };
  assert.equal(await h.events.get('input')(message, h.ctx), undefined);
  assert.equal(await h.events.get('input')(message, h.ctx), undefined);
  const state = h.store.load();
  assert.equal(state.evidence.filter(item => item.kind === 'delivery' && item.taskId === task.id).length, 1);
  assert.ok(state.evidence.some(item => item.kind === 'schedule' && item.taskId === task.id));
  assert.equal(state.evidence.some(item => item.kind === 'outcome'), false);
});

test('stop preserves an externally disabled daily wake instead of adopting and reviving it', async t => {
  const h = await runtimeFixture(t);
  await h.runtime.start(h.ctx);
  h.tasks[0].enabled = false;
  h.tasks[0].disabledAt = 'manually-disabled';
  h.save();
  await h.runtime.stop(h.ctx);
  await assert.rejects(h.runtime.start(h.ctx), /outside Companion/);
  assert.equal(h.tasks[0].enabled, false);
});

test('applied changes retain their intended benefit for later outcome comparison', async t => {
  const h = fixture(t);
  h.store.update(state => {
    state.decisions.push({ id: 'time-change', action: 'revise', taskId: 'task_reading', proposal: 'Move the task to Friday.',
      successSignal: 'Less interruption during busy mornings.', evidenceIds: ['answer'], at: new Date().toISOString(), appliedEvidenceIds: ['receipt'] });
    recordEvidence(state, { id: 'receipt', kind: 'schedule', taskId: 'task_reading', text: 'Changed to Friday.', provider: 'openai-codex' });
  });
  await review(h.store, h.ctx, h.settings, new AbortController().signal);
  assert.match(h.calls[0][1].messages[0].content, /Less interruption/);
});

test('questions survive reload and answers lead to an applied change evaluated on the next day', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-18T16:00:00Z') });
  const h = await runtimeFixture(t);
  const { registerCompanion } = await jiti.import('../src/index.ts');
  await h.runtime.start(h.ctx);
  const dailyId = h.store.load().wake.schedulerId;
  const task = {
    id: 'task_reading', name: 'Reading', action: 'prompt', type: 'interval', schedule: '1d',
    prompt: 'Read the current Reading registry entry.', scope: 'session', sessionFile: 'owner.jsonl', enabled: true, status: 'pending',
  };
  h.tasks.push(task);
  h.save();
  const record = params => h.tools.get('companion_record').execute('record', params, undefined, undefined, h.ctx);
  const input = text => h.events.get('input')({ source: 'interactive', text }, h.ctx);
  const daily = () => h.events.get('input')({ source: 'extension', text: h.fire(h.tasks[0]) }, h.ctx);
  const question = { kind: 'question', id: 'timing', text: 'When would this check help?', evidenceIds: [] };
  await record(question);
  await record({ ...question, id: 'interests', text: 'Which topic should we explore next?' });

  h.runtime.shutdown();
  registerCompanion(h.pi, h.paths);
  await h.events.get('session_start')({ reason: 'reload' }, h.ctx);
  assert.equal(h.tasks.length, 2);
  assert.equal(h.store.load().wake.schedulerId, dailyId);
  assert.equal(h.store.load().enabled, true);
  assert.equal(h.store.load().questions[0].status, 'open');
  assert.equal(h.tools.get('companion_record').parameters.type, 'object');
  await record(question);
  await input('Friday afternoon, after the work week ends.');
  const answer = h.store.load().evidence.find(item => item.text === 'Friday afternoon, after the work week ends.');
  const decision = {
    id: 'friday-check', action: 'revise', taskId: task.id, proposal: 'Move Reading to Friday at 16:00.',
    successSignal: 'The check helps plan next week without interrupting morning work.', evidenceIds: [answer.id],
  };
  h.setResult(response({
    ...emptyReview(),
    decisions: [decision],
    answers: [{ questionId: question.id, evidenceIds: [answer.id] }],
    lessons: [{ id: 'reading-time', action: 'upsert', text: 'Try Reading on Friday afternoons.', confidence: 'supported', evidenceIds: [answer.id] }],
  }));
  await daily();
  assert.equal(h.store.load().questions[0].status, 'answered');
  assert.match(h.messages.at(-1), /friday-check/);

  // The existing actor applies through its scheduler tool; its receipt is the boundary under test.
  t.mock.timers.tick(1000);
  Object.assign(task, { type: 'cron', schedule: '0 0 16 * * 5' });
  h.save();
  await h.events.get('tool_result')({ toolName: 'manage_scheduled_task', toolCallId: 'move-to-friday', isError: false, details: { task } }, h.ctx);
  const receipt = h.store.load().evidence.find(item => item.kind === 'schedule' && item.text.includes(task.schedule));
  await record({ kind: 'applied', id: 'applied-friday', decisionId: decision.id, evidenceIds: [receipt.id] });
  await h.events.get('input')({ source: 'extension', text: h.fire(task) }, h.ctx);
  const delivery = h.store.load().evidence.find(item => item.kind === 'delivery' && item.taskId === task.id);
  await record({ kind: 'outcome', id: 'friday-result', taskId: task.id, runId: delivery.runId, text: 'Completed the approved checklist.', outcome: 'completed', evidenceIds: [] });
  await input('That helped me plan next week. Keep Friday.');
  const feedback = h.store.load().evidence.find(item => item.text === 'That helped me plan next week. Keep Friday.');

  t.mock.timers.tick(86400000);
  h.setResult(response({
    ...emptyReview(),
    assessments: [{ taskId: task.id, signal: 'helpful', basis: 'explicit', reason: 'The user said this helped with next week.', evidenceIds: [feedback.id, 'friday-result'] }],
    lessons: [{ id: 'reading-time', action: 'upsert', text: 'Keep Reading on Friday afternoons for weekly planning.', confidence: 'supported', evidenceIds: [feedback.id] }],
  }));
  await daily();
  const nextContext = JSON.parse(h.calls[1][1].messages[0].content);
  assert.equal(nextContext.appliedDecisions[0].successSignal, decision.successSignal);
  assert.ok(nextContext.evidence.some(item => item.id === 'friday-result'));
  assert.equal(h.store.load().reviews.filter(item => item.status === 'completed').length, 2);
  assert.equal(view(h.store.load()).lessons[0].text, 'Keep Reading on Friday afternoons for weekly planning.');
  assert.equal(h.store.load().lessons.length, 2);
  assert.equal(h.store.load().questions[1].status, 'open');
  assert.equal(readFileSync(h.paths.reportsFile, 'utf8').match(/Which topic should we explore next/g).length, 1);
  assert.equal(readFileSync(h.paths.reportsFile, 'utf8').match(/When would this check help/g).length, 1);
  assert.equal(h.notices.length, 0);
});

test('review context excludes evidence and learned text from another provider', async t => {
  const h = fixture(t);
  h.store.update(state => {
    recordEvidence(state, { id: 'private', kind: 'user', text: 'Do not disclose this earlier-provider text.', provider: 'other' });
    state.lessons.push({ id: 'private-lesson', action: 'upsert', text: 'Secret derived lesson.', confidence: 'supported', evidenceIds: ['private'], at: new Date().toISOString() });
  });
  await review(h.store, h.ctx, h.settings, new AbortController().signal);
  const context = JSON.stringify(h.calls[0][1]);
  assert.doesNotMatch(context, /earlier-provider|Secret derived/);
  assert.match(context, /Friday afternoons/);
});
