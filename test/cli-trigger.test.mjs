import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialize } from '../src/cli/config.mjs';
import { CompanionApplication } from '../src/cli/application.mjs';
import { openPiSession } from '../src/cli/pi-session.mjs';
import { CompanionRuntime } from '../src/cli/runtime.mjs';
import { CompanionRunner } from '../src/cli/runner.mjs';
import { createAgentSession, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';

async function fixture(t, runHarness) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'companion-trigger-')));
  initialize(root, { cwd: root, now: '2026-01-01T00:00:00Z' });
  const file = join(root, 'schedules/daily/email.md');
  const schedule = {
    id: 'email',
    title: 'Email follow-up',
    enabled: false,
    window: { start: '09:00', end: '10:00', everyMinutes: 60 },
    timezone: 'UTC',
    cwd: root,
    harness: 'claude',
    model: 'fixture',
    effort: 'high',
    context: ['source'],
  };
  writeFileSync(join(root, 'source'), 'Explicit fixture context');
  const save = () => writeFileSync(file, `---\n${JSON.stringify(schedule)}\n---\nCheck fixture only.\n`);
  save();
  const model = {
    id: 'local',
    provider: 'fixture',
    name: 'Synthetic',
    api: 'openai-completions',
    baseUrl: 'https://invalid.test',
    reasoning: true,
    input: ['text'],
    contextWindow: 32000,
    maxTokens: 2048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const models = await ModelRuntime.create({
    authPath: join(root, 'auth.json'),
    modelsPath: null,
    modelsStorePath: join(root, 'models.json'),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  models.getModel = () => model;
  models.streamSimple = () => { throw Error('No provider allowed'); };
  const app = await CompanionApplication.open(root, {
    now: () => new Date('2026-04-27T23:00:00Z'),
    runHarness,
    createMain: options => openPiSession(options, {
      agentDir: join(root, 'agent'),
      createSession: options => createAgentSession({
        ...options,
        modelRuntime: models,
        model,
        tools: ['run_schedule'],
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      }),
    }),
  });
  t.after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const tool = app.runtime.main.agent.state.tools.find(tool => tool.name === 'run_schedule');
  assert.ok(tool, 'real SDK registers main-session trigger tool');
  return { root, file, schedule, save, app, tool, config: app.config };
}
const outcome = {
  status: 'completed',
  text: JSON.stringify({
    outcome: 'no_change',
    body: 'Checked fixture: nothing new',
    checks: [{ source: 'fixture', outcome: 'no_change', detail: 'Checked' }],
  }),
};

test('exact-ID one-off is durable, asynchronous, replay-safe, visible and leaves paused settings intact', async t => {
  const done = Promise.withResolvers();
  t.after(() => done.resolve({ status: 'interrupted' }));
  let calls = 0;
  const h = await fixture(t, request => {
    calls++;
    assert.equal(request.model, 'fixture');
    assert.equal(request.effort, 'high');
    assert.equal(request.harness, 'claude');
    assert.match(request.prompt, /Explicit fixture context/);
    return done.promise;
  });
  const original = readFileSync(h.file, 'utf8');
  const release = h.app.runtime.reserveSession(h.app.runtime.main.sessionId);
  const result = (await h.tool.execute('explicit-one', { scheduleId: 'email' })).details;
  assert.equal(result.status, 'running');
  assert.match(result.id, /^once:/);
  assert.equal(h.app.runtime.mainBusy, true);
  assert.equal((await h.app.runtime.state()).runs[result.id].status, 'running');
  await assert.rejects(h.tool.execute('overlap', { scheduleId: 'email' }), /running|overlap/i);
  done.resolve(outcome);
  release();
  await h.app.runtime.idle();
  assert.equal((await h.tool.execute('explicit-one', { scheduleId: 'email' })).details.status, 'no_change');
  assert.equal(calls, 1);
  const view = await h.app.refresh();
  assert.equal(view.reports.find(report => report.id === result.id).body, 'Checked fixture: nothing new');
  assert.equal(readFileSync(h.file, 'utf8'), original);
  assert.equal(view.schedules[0].enabled, false);
  assert.equal(view.schedules[0].nextRun.state, 'paused');
});

test('one-offs do not consume calendar occurrences and reopened Durable receipts prevent replay', async t => {
  let calls = 0;
  const h = await fixture(t, async () => { calls++; return outcome; });
  h.schedule.enabled = true;
  h.schedule.at = '09:00';
  delete h.schedule.window;
  h.save();
  const manual = (await h.tool.execute('persisted', { scheduleId: 'email' })).details;
  await h.app.runtime.idle();
  const callId = `${h.app.runtime.main.sessionId}:persisted`;
  await h.app.runner.tick();
  await h.app.runtime.idle();
  assert.equal(calls, 2);
  assert.equal((await h.app.runtime.state()).runs['email:2026-04-27'].status, 'no_change');
  await h.app.close();
  const runtime = await CompanionRuntime.open(h.root, h.config);
  const runner = new CompanionRunner({
    runtime,
    root: h.root,
    config: h.config,
    now: () => new Date('2026-04-27T23:00:00Z'),
    runHarness: async () => { throw Error('Must not replay'); },
  });
  try {
    assert.deepEqual(await runner.trigger('email', callId), { id: manual.id, status: 'no_change', replay: true });
    await runner.tick();
    assert.equal(Object.keys((await runtime.state()).runs).length, 2);
  } finally {
    await runner.stop();
    await runtime.close();
  }
});

test('candidate listing, invalid authority, cancellation and shutdown never guess or bypass native validation', async t => {
  let calls = 0;
  const h = await fixture(t, request => {
    calls++;
    return new Promise(resolve => request.signal.addEventListener('abort', () => resolve({ status: 'interrupted' }), { once: true }));
  });
  const listing = (await h.tool.execute('list', {})).details;
  assert.deepEqual(listing.schedules, [{ id: 'email', title: 'Email follow-up', enabled: false }]);
  await assert.rejects(h.tool.execute('unknown', { scheduleId: 'unknown' }), /exact|unknown/i);
  await assert.rejects(h.tool.execute('override', { scheduleId: 'email', model: 'other' }), /Invalid/);
  const aborted = AbortSignal.abort();
  await assert.rejects(h.tool.execute('aborted', { scheduleId: 'email' }, aborted), /abort/i);
  h.schedule.context = ['missing'];
  h.save();
  await assert.rejects(h.tool.execute('missing', { scheduleId: 'email' }), /ENOENT/);
  assert.equal(calls, 0);
  h.schedule.context = ['source'];
  h.save();
  const receipt = (await h.tool.execute('cancel', { scheduleId: 'email' })).details;
  h.app.runner.config.concurrency = 1;
  writeFileSync(join(h.root, 'schedules/daily/other.md'), `---\n${JSON.stringify({ ...h.schedule, id: 'other' })}\n---\nOther fixture.\n`);
  await assert.rejects(h.tool.execute('capacity', { scheduleId: 'other' }), /capacity/i);
  await assert.rejects(h.tool.execute('cancel', { scheduleId: 'other' }), /another schedule/i);
  await h.app.runtime.cancel(receipt.id);
  assert.equal((await h.app.runtime.state()).runs[receipt.id].status, 'interrupted');
  await h.tool.execute('shutdown', { scheduleId: 'email' });
  await h.app.close();
  await assert.rejects(h.tool.execute('closed', { scheduleId: 'email' }), /stopped|closing|stale/i);
  assert.equal(calls, 2);
});
