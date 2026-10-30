import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initialize, atomicJson } from '../src/cli/config.mjs';
import { CompanionApplication, readLocalView } from '../src/cli/application.mjs';
import { CompanionRuntime } from '../src/cli/runtime.mjs';
import { saveReport } from '../src/cli/reports.mjs';
import { readPresentationState, savePresentationState } from '../src/cli/view.mjs';
import { fakePi } from './helpers/pi-session.mjs';
import { createDashboard } from '../src/cli/ui.mjs';
import { stripTerminalSequences } from '@earendil-works/pi-tui';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'companion-app-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = initialize(root, { cwd: root, now: '2026-01-01T00:00:00Z' });
  config.main.model = 'fixture/local';
  config.background.model = 'fixture/check';
  atomicJson(join(root, 'config.json'), config);
  const fake = fakePi(root);
  return {
    root, config, fake,
    openApp: (options = {}) => CompanionApplication.open(root, { createMain: fake.createMain, ...options }),
  };
}

test('presentation clear state is private, unions across writes and hides messages after reopen', t => {
  const h = fixture(t);
  atomicJson(join(h.root, 'runtime/view.json'), {
    version: 1,
    messages: [
      { id: 'old', role: 'assistant', content: 'Old answer' },
      { id: 'new', role: 'assistant', content: 'New answer' },
    ],
  });
  assert.deepEqual(savePresentationState(h.root, ['old']).hiddenMessageIds, ['old']);
  assert.deepEqual(savePresentationState(h.root, ['new']).hiddenMessageIds, ['old', 'new']);
  assert.deepEqual(readPresentationState(h.root).hiddenMessageIds, ['old', 'new']);
  const file = join(h.root, 'runtime/presentation.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const saved = readFileSync(file, 'utf8');
  const tooMany = Array.from({ length: 10000 }, (_, index) => `message-${index}-${'x'.repeat(100)}`);
  assert.throws(() => savePresentationState(h.root, tooMany), /byte limit/i);
  assert.equal(readFileSync(file, 'utf8'), saved);
  const reopened = readLocalView(h.root);
  assert.deepEqual(reopened.presentation.hiddenMessageIds, ['old', 'new']);
  const ui = createDashboard(reopened);
  assert.doesNotMatch(stripTerminalSequences(ui.render(80, 24).join('\\n')), /Old answer|New answer/);
});

test('saved reports retain real results from an older view format', t => {
  const h = fixture(t);
  const report = { id: 'check:one', title: 'Local check', body: 'A real finding' };
  atomicJson(join(h.root, 'runtime/view.json'), {
    version: 1,
    reports: [{ id: 'patterns-offer', body: 'Old setup guide' }, report],
  });

  const local = readLocalView(h.root);
  assert.deepEqual(local.reports, [report]);
});

test('local imported reports survive saved views, live refresh and restart without entering context or spend', async t => {
  const h = fixture(t);
  const historical = {
    id: 'local:original:report',
    title: 'Historical report',
    body: 'Preserved history',
    at: '2025-12-01T00:00:00Z',
    outcome: 'imported',
    origin: 'legacy-state',
    path: '/original/report.json',
    readState: 'read',
    readAt: '2025-12-02T00:00:00Z',
  };
  const file = join(h.root, 'runtime/imported-reports.json');
  atomicJson(file, { version: 1, reports: [historical] });
  atomicJson(join(h.root, 'runtime/view.json'), { version: 1, reports: [] });
  assert.deepEqual(readLocalView(h.root).reports, [{ ...historical, truncated: false }]);
  const bytes = readFileSync(file, 'utf8');
  for (let attempt = 0; attempt < 2; attempt++) {
    const app = await h.openApp();
    try {
      const view = await app.refresh();
      assert.equal(view.reports.length, 1);
      assert.equal(view.reports[0].readAt, historical.readAt);
      assert.equal(view.usage.usd, 0);
      assert.equal(app.runtime.messages().length, 0);
      assert.deepEqual((await app.runtime.state()).runs, {});
    } finally {
      await app.close();
    }
    assert.equal(readLocalView(h.root).reports.length, 1);
  }
  assert.equal(readFileSync(file, 'utf8'), bytes);
  atomicJson(file, { version: 1, reports: [{ ...historical, body: null }] });
  assert.throws(() => readLocalView(h.root), /imported report/i);
});

test('connected application serves input while a background check waits, saves reports/cost, and restores one main', { timeout: 10000 }, async t => {
  const h = fixture(t);
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  const schedule = {
    id: 'check',
    title: 'Check',
    at: '09:00',
    timezone: 'UTC',
    cwd: h.root,
    context: [],
    enabled: true,
    harness: 'pi',
    model: 'fixture/check',
    effort: 'medium',
  };
  for (const id of ['check', 'check-two']) {
    writeFileSync(join(h.root, `schedules/daily/${id}.md`), `---\n${JSON.stringify({ ...schedule, id })}\n---\nCheck local state.\n`);
  }
  let now = new Date('2026-01-02T10:00:00Z');
  let calls = 0;
  const answer = '# Findings\n\nA useful detail\n';
  const failure = 'Pi session identity changed during the job.';
  const failureBody = `${answer}\n\n---\n\n**Execution failure:** ${failure}`;
  const runHarness = async request => {
    const call = ++calls;
    if (call === 2) started.resolve();
    await gate.promise;
    return {
      status: call === 1 ? 'failed' : 'completed',
      sessionId: request.id,
      freshSession: true,
      cost: { usd: 0.1, sessionId: request.id, kind: 'estimate', cumulative: true },
      text: answer,
      ...(call === 1 ? { error: failure } : {}),
    };
  };
  const app = await h.openApp({
    runHarness,
    sessionDependencies: h.fake.dependencies,
    now: () => now,
    intervalMs: 60000,
  });
  t.after(async () => {
    gate.resolve();
    await app.close();
  });

  await app.runner.tick();
  assert.deepEqual((await app.runner.snapshot()).errors, []);
  await started.promise;
  const control = h.fake.controls.get(app.runtime.main.sessionId);
  control.gate = Promise.withResolvers();
  await app.send('Hello');
  const concurrent = await app.refresh();
  assert.equal(concurrent.runs.filter(run => run.state === 'running').length, 3);
  assert.deepEqual(concurrent.runs.filter(run => run.state === 'running').map(run => run.kind).sort(), ['background', 'background', 'main']);
  control.gate.resolve();
  await app.runtime.mainWork;
  assert.equal(app.runtime.mainBusy, false);
  assert.equal(app.runtime.active.size, 2);
  const ui = createDashboard(await app.refresh(), { send: text => app.send(text) });
  const sessionBytes = readFileSync(app.runtime.main.sessionFile, 'utf8');
  const stateBeforeClear = await app.runtime.state();
  ui.input('/clear');
  ui.input('\r');
  await ui.pending();
  ui.update(await app.refresh());
  assert.doesNotMatch(stripTerminalSequences(ui.render(80, 24).join('\n')), /Reply: Hello/);
  assert.equal(readFileSync(app.runtime.main.sessionFile, 'utf8'), sessionBytes);
  assert.deepEqual(await app.runtime.state(), stateBeforeClear);
  assert.equal(app.runtime.active.size, 2);

  gate.resolve();
  await app.runtime.idle();
  await app.refresh();
  const snapshot = app.snapshot;
  assert.equal(snapshot.connection, 'connected');
  assert.equal(snapshot.counts.daily, 2);
  assert.equal(snapshot.runs.filter(run => run.state === 'running').length, 0);
  assert.equal(snapshot.schedules[0].nextRun.at, '2026-01-03T09:00:00.000Z');
  assert.ok(snapshot.messages.some(message => message.content === 'Reply: Hello'));
  const backgroundRuns = Object.values((await app.runtime.state()).runs).filter(run => run.kind === 'background');
  const failedRun = backgroundRuns.find(run => run.status === 'failed');
  const completedRun = backgroundRuns.find(run => run.status === 'completed');
  assert.ok(failedRun && completedRun);
  const files = readdirSync(join(h.root, 'reports')).map(name => join(h.root, 'reports', name));
  assert.equal(files.length, 2);
  assert.deepEqual(files.map(file => readFileSync(file, 'utf8')).sort(), [answer, failureBody].sort());
  const failedReport = snapshot.reports.find(report => report.id === failedRun.id);
  assert.equal(failedReport.body, failureBody);
  assert.equal(snapshot.reports.find(report => report.id === completedRun.id).body, answer);
  const failureUi = createDashboard({ ...snapshot, reports: [failedReport] });
  failureUi.input('\x1b[C');
  failureUi.input('\x1b[B');
  failureUi.input('\r');
  const displayedFailure = stripTerminalSequences(failureUi.render(120, 40).join('\n'));
  assert.match(displayedFailure, /A useful detail/);
  assert.match(displayedFailure, /Pi session identity changed during the job\./);
  const viewFile = join(h.root, 'runtime/view.json');
  const savedView = readFileSync(viewFile, 'utf8');
  const displayedTick = app.snapshot.lastTick;
  const persistedTick = (await app.runtime.state()).lastTick;
  now = new Date(now.getTime() + 1000);
  await app.runner.tick();
  await app.refresh();
  assert.notEqual(app.snapshot.lastTick, displayedTick);
  assert.equal(app.snapshot.lastTick, now.toISOString());
  assert.equal((await app.runtime.state()).lastTick, persistedTick);
  assert.equal(readFileSync(viewFile, 'utf8'), savedView);
  const fromFile = '# Reviewed file\n\nFile is authoritative.\n';
  const completedFile = files.find(file => readFileSync(file, 'utf8') === answer);
  writeFileSync(completedFile, fromFile);
  await app.runtime.finish(completedRun.id, completedRun.result);
  await assert.rejects(app.runtime.finish(completedRun.id, { status: 'failed', text: 'Replacement' }), /conflicting/);
  assert.equal(readFileSync(completedFile, 'utf8'), fromFile);
  assert.ok(Math.abs(snapshot.usage.usd - 0.45) < 1e-9);
  assert.equal(statSync(join(h.root, 'runtime/view.json')).mode & 0o777, 0o600);
  await assert.rejects(h.openApp(), /already running/);
  const sessionId = app.runtime.main.sessionId;
  await app.close();
  const local = readLocalView(h.root);
  assert.equal(local.connection, 'offline');
  assert.equal(local.reports.find(report => report.id === failedRun.id).body, failureBody);
  assert.equal(local.reports.find(report => report.id === completedRun.id).body, fromFile);
  assert.ok(Math.abs(local.usage.usd - 0.45) < 1e-9);
  assert.ok(local.messages.some(message => message.content === 'Reply: Hello'));
  const restored = await h.openApp({ runHarness, now: () => new Date('2026-01-02T10:00:00Z') });
  try {
    await restored.runner.tick();
    await restored.runtime.idle();
    assert.equal(restored.runtime.main.sessionId, sessionId);
    const restoredReports = (await restored.refresh()).reports;
    assert.equal(restoredReports.find(report => report.id === failedRun.id).body, failureBody);
    assert.equal(restoredReports.find(report => report.id === completedRun.id).body, fromFile);
    assert.equal(calls, 2);
  } finally {
    await restored.close();
  }
});

test('activity projection keeps live scheduled jobs visible beyond history limits', async t => {
  const h = fixture(t);
  for (const [id, title, at] of [['daily-one', 'Daily audit', '09:00'], ['daily-two', 'Backup review', '10:00']]) {
    const schedule = {
      id,
      title,
      at,
      timezone: 'UTC',
      cwd: h.root,
      context: [],
      enabled: true,
      harness: 'pi',
      model: 'fixture/check',
      effort: 'medium',
    };
    writeFileSync(join(h.root, `schedules/daily/${id}.md`), `---\n${JSON.stringify(schedule)}\n---\nCheck local state.\n`);
  }
  const app = await h.openApp();
  const state = app.runtime.state.bind(app.runtime);
  const runs = {
    main: { id: 'main', kind: 'main', status: 'running', startedAt: '2026-01-02T09:00:00Z' },
    'daily-job': {
      id: 'daily-job', kind: 'background', scheduleId: 'daily-one', title: 'Daily audit', status: 'running',
      harness: 'fixture-harness', model: 'fixture/daily', effort: 'high', cwd: '/tmp/live-daily',
      startedAt: '2026-01-02T10:00:00Z',
    },
    'backup-job': {
      id: 'backup-job', kind: 'background', scheduleId: 'daily-two', title: 'Backup review', status: 'running',
      harness: 'fixture-harness', model: 'fixture/backup', effort: 'low', cwd: '/tmp/live-backup',
      startedAt: '2026-01-02T10:01:00Z',
    },
  };
  for (let index = 0; index < 105; index++) {
    const id = `history-${String(index).padStart(3, '0')}`;
    runs[id] = {
      id,
      kind: 'background',
      status: 'completed',
      startedAt: new Date(Date.parse('2026-01-03T00:00:00Z') + index * 1000).toISOString(),
    };
  }
  app.runtime.state = async () => ({ ...await state(), runs });
  try {
    const view = await app.refresh();
    assert.equal(view.counts.daily, 2);
    assert.equal(view.runs.length, 103);
    assert.ok(view.runs.some(run => run.id === 'history-104'));
    assert.ok(!view.runs.some(run => run.id === 'history-004'));
    assert.deepEqual(
      view.runs.filter(run => run.state === 'running').map(run => run.id).sort(),
      ['backup-job', 'daily-job', 'main'],
    );
    assert.equal(view.runs.find(run => run.id === 'daily-job').scheduleId, 'daily-one');
    assert.equal(view.runs.find(run => run.id === 'backup-job').scheduleId, 'daily-two');
    const ui = createDashboard(view);
    ui.input('\x1b[C');
    ui.input('\x1b[C');
    const live = stripTerminalSequences(ui.render(140, 60).join('\n'));
    assert.match(live, /Schedules 2\b/);
    assert.match(live, /2 running/);
    for (const text of [
      'Daily audit', 'Backup review', 'fixture-harness', 'fixture/daily', 'fixture/backup',
      'high', 'low',
    ]) {
      assert.ok(live.includes(text), `Missing live schedule detail: ${text}`);
    }
    const offline = readLocalView(h.root);
    assert.equal(offline.connection, 'offline');
    assert.equal(offline.runs.filter(run => run.state === 'running').length, 3);
    const staleUi = createDashboard(offline);
    staleUi.input('\x1b[C');
    staleUi.input('\x1b[C');
    const stale = stripTerminalSequences(staleUi.render(140, 60).join('\n'));
    assert.doesNotMatch(stale, /Running now|2 running/);
  } finally {
    app.runtime.state = state;
    await app.close();
  }
});

test('closing drains interrupted background and main work and releases ownership without retrying', async t => {
  const h = fixture(t);
  const app = await h.openApp();
  const control = h.fake.controls.get(app.runtime.main.sessionId);
  control.gate = Promise.withResolvers();
  await app.send('Wait here');
  await app.close();
  await app.close();
  assert.equal(control.aborted, true);
  const local = readLocalView(h.root);
  assert.ok(local.runs.some(run => run.state === 'interrupted'));
  assert.ok(local.usage.issues.missing_final_receipt > 0);
  const next = await h.openApp();
  await next.close();
  assert.equal(control.calls, 1);
});

const backgroundRun = (id, overrides = {}) => ({
  id,
  kind: 'background',
  scheduleId: id,
  title: id,
  status: 'completed',
  startedAt: '2026-01-02T08:00:00.000Z',
  finishedAt: '2026-01-02T08:01:00.000Z',
  result: { status: 'completed', text: 'Synthetic report.' },
  ...overrides,
});

test('visible scheduled reports add stable local notices without changing context', async t => {
  const h = fixture(t);
  let providerCalls = 0;
  const runHarness = async () => {
    providerCalls++;
    throw Error('Unexpected provider call in synthetic notice test.');
  };
  const importedReport = {
    id: 'imported:prior',
    title: 'Imported report',
    body: 'Imported body',
    at: '2025-12-01T00:00:00Z',
    outcome: 'imported',
    origin: 'legacy-state',
    path: '/prior/report.json',
    readState: 'unread',
    readAt: null,
  };
  atomicJson(join(h.root, 'runtime/imported-reports.json'), { version: 1, reports: [importedReport] });
  const seed = await CompanionRuntime.open(h.root, h.config);
  await seed.change(state => { state.runs['old-schedule'] = backgroundRun('old-schedule'); });
  await seed.close();

  const app = await h.openApp({ runHarness });
  let notice;
  let notices;
  try {
    assert.equal((await app.refresh()).messages.filter(message => message.role === 'notice').length, 0);
    const contextMessagesBefore = app.runtime.messages();
    await app.runtime.change(state => {
      state.runs['new-schedule'] = backgroundRun('new-schedule', {
        title: 'Morning check', finishedAt: '2026-01-02T09:01:00.000Z',
      });
      state.runs['calendar-no-change'] = backgroundRun('calendar-no-change', { status: 'no_change' });
      state.runs['manual-no-change'] = backgroundRun('manual-no-change', { status: 'no_change', trigger: 'manual' });
      state.runs['scheduled-failure'] = backgroundRun('scheduled-failure', { status: 'failed' });
      state.runs['scheduled-incomplete'] = backgroundRun('scheduled-incomplete', { status: 'incomplete' });
      const maintenance = backgroundRun('background-maintenance', { status: 'failed' });
      delete maintenance.scheduleId;
      state.runs['background-maintenance'] = maintenance;
    });
    const view = await app.refresh();
    notices = view.messages.filter(message => message.role === 'notice');
    notice = notices.find(message => /Morning check/i.test(message.content));
    assert.deepEqual(notices.map(message => message.content).sort(), [
      'Report available for Morning check', 'Report available for manual-no-change',
      'Report available for scheduled-failure', 'Report available for scheduled-incomplete',
    ].sort());
    assert.equal(notice.at, '2026-01-02T09:01:00.000Z');
    assert.deepEqual(app.runtime.messages(), contextMessagesBefore);
    assert.equal(view.reports.find(report => report.id === 'new-schedule').at, notice.at);
    assert.equal(view.reports.some(report => report.id === 'calendar-no-change'), false);
    assert.equal(view.reports.find(report => report.id === 'manual-no-change').outcome, 'no_change');
    assert.equal(view.reports.find(report => report.id === 'scheduled-failure').outcome, 'failed');
    assert.equal(view.reports.find(report => report.id === 'scheduled-incomplete').outcome, 'incomplete');
    assert.ok(view.reports.some(report => report.id === 'background-maintenance'));
    assert.equal(view.reports.find(report => report.id === 'imported:prior').at, '2025-12-01T00:00:00Z');
    assert.deepEqual((await app.refresh()).messages.filter(message => message.role === 'notice').map(message => message.id).sort(),
      notices.map(message => message.id).sort());
    assert.equal(view.usage.usd, 0);
    assert.equal(statSync(join(h.root, 'runtime/view.json')).mode & 0o777, 0o600);
    assert.equal(providerCalls, 0);
  } finally {
    await app.close();
  }

  const reopened = await h.openApp({ runHarness });
  try {
    const view = await reopened.refresh();
    assert.deepEqual(view.messages.filter(message => message.role === 'notice').map(message => message.id).sort(),
      notices.map(message => message.id).sort());
    const ui = createDashboard(view, { clear: ids => savePresentationState(h.root, ids) });
    ui.input('/clear');
    ui.input('\r');
    await ui.pending();
    ui.update(await reopened.refresh());
    assert.doesNotMatch(stripTerminalSequences(ui.render(80, 24).join('\n')), /Report available for Morning check/);
  } finally {
    await reopened.close();
  }

  const hidden = readLocalView(h.root);
  assert.ok(notices.every(message => hidden.presentation.hiddenMessageIds.includes(message.id)));
  const final = await h.openApp({ runHarness });
  try {
    const view = await final.refresh();
    assert.deepEqual(view.messages.filter(message => message.role === 'notice').map(message => message.id).sort(),
      notices.map(message => message.id).sort());
    assert.doesNotMatch(stripTerminalSequences(createDashboard(view).render(80, 24).join('\n')), /Report available for/);
    assert.equal(providerCalls, 0);
  } finally {
    await final.close();
  }
});

test('scheduled reports talk back in chat only for critical or useful triage lines', async t => {
  const h = fixture(t);
  const runHarness = async () => { throw Error('Unexpected provider call in synthetic triage test.'); };
  const app = await h.openApp({ runHarness });
  try {
    const contextMessagesBefore = app.runtime.messages();
    await app.runtime.change(state => {
      state.runs.critical = backgroundRun('critical', {
        title: 'Financial freedom',
        result: { status: 'completed', text: '**Critical:** Rent is due tomorrow and the balance is short.\n\nDetails.' },
      });
      state.runs.useful = backgroundRun('useful', {
        title: 'Health progress',
        result: { status: 'completed', text: 'Useful: Resting heart rate fell 3 bpm over two weeks.\n\nDetails.' },
      });
      state.runs.quiet = backgroundRun('quiet', {
        title: 'Calendar deadlines',
        result: { status: 'completed', text: 'Nothing new.\n\nChecked the next 14 days.' },
      });
    });

    const view = await app.refresh();

    const notices = view.messages.filter(message => message.role === 'notice')
      .map(({ content, tone }) => ({ content, tone }))
      .sort((left, right) => left.content.localeCompare(right.content));
    assert.deepEqual(notices, [
      { content: 'Financial freedom: Rent is due tomorrow and the balance is short.', tone: 'critical' },
      { content: 'Health progress: Resting heart rate fell 3 bpm over two weeks.', tone: 'useful' },
    ]);
    assert.ok(view.reports.some(report => report.id === 'quiet'));
    assert.deepEqual(app.runtime.messages(), contextMessagesBefore);
  } finally {
    await app.close();
  }
});

test('application kill delegates the run ID and preserves false/error outcomes', async t => {
  const h = fixture(t);
  const app = await h.openApp();
  t.after(async () => app.close());
  const requested = [];
  app.runner.kill = async runId => {
    requested.push(runId);
    if (runId === 'error') throw Error('Cancellation unavailable.');
    return runId === 'live-owned';
  };

  assert.equal(await app.kill('live-owned'), true);
  assert.equal(await app.kill('stale'), false);
  await assert.rejects(app.kill('error'), /Cancellation unavailable/);
  assert.deepEqual(requested, ['live-owned', 'stale', 'error']);
});

test('application reset refreshes the connected view after preserving the previous session', async t => {
  const h = fixture(t);
  const toolSets = [];
  const createSession = h.fake.dependencies.createSession;
  h.fake.dependencies.createSession = async options => {
    toolSets.push(options.customTools);
    return createSession(options);
  };
  const app = await h.openApp();
  t.after(async () => app.close());
  await app.send('Preserve this transcript');
  await app.runtime.idle();

  const previous = app.runtime.main;
  const previousBytes = readFileSync(previous.sessionFile);
  const binding = app.snapshot.main;
  const dashboard = createDashboard(app.snapshot);
  app.onChange = view => dashboard.update(view);
  const reset = await app.reset();
  const tools = toolSets.at(-1);
  assert.deepEqual(tools.map(tool => tool.name), ['ask_question', 'run_schedule', 'model_settings']);
  const activeBinding = (await tools.find(tool => tool.name === 'model_settings').execute('binding', {
    action: 'inspect', scope: 'main',
  })).details.activeMainBinding;
  assert.deepEqual(activeBinding, { model: binding.model, effort: binding.effort });

  assert.notEqual(reset.sessionId, previous.sessionId);
  assert.equal((await app.runtime.state()).main.sessionId, reset.sessionId);
  assert.equal(app.runtime.messages().length, 0);
  assert.equal(app.snapshot.connection, 'connected');
  assert.equal(app.snapshot.messages.length, 0);
  assert.equal(app.snapshot.main.model, binding.model);
  assert.equal(app.snapshot.main.effort, binding.effort);
  assert.equal(app.snapshot.usage.usd, 0);
  assert.match(stripTerminalSequences(dashboard.render(80, 24).join('\n')), /\$0\.00 est\./);
  assert.equal(readLocalView(h.root).usage.usd, 0);
  assert.deepEqual(readFileSync(previous.sessionFile), previousBytes);
  const header = JSON.parse(readFileSync(reset.sessionFile, 'utf8').split('\\n')[0]);
  assert.equal(header.id, reset.sessionId);
  assert.equal(statSync(reset.sessionFile).mode & 0o777, 0o600);

  await app.send('Accrue from reset');
  await app.runtime.idle();
  assert.equal((await app.refresh()).usage.usd, 0.25);
  assert.match(stripTerminalSequences(dashboard.render(80, 24).join('\n')), /\$0\.25 est\./);
  assert.equal(readLocalView(h.root).usage.usd, 0.25);
});

test('failed application reset leaves the displayed estimate unchanged', async t => {
  const h = fixture(t);
  const createMain = h.fake.createMain;
  let failFresh = false;
  h.fake.createMain = options => options.fresh && failFresh
    ? Promise.reject(Error('Unable to start fresh session.'))
    : createMain(options);
  const app = await h.openApp();
  t.after(() => app.close());
  await app.send('Keep this estimate');
  await app.runtime.idle();
  assert.equal((await app.refresh()).usage.usd, 0.25);

  failFresh = true;
  await assert.rejects(app.reset(), /Unable to start fresh session/);
  assert.equal(app.snapshot.usage.usd, 0.25);
  assert.equal(readLocalView(h.root).usage.usd, 0.25);
});

test('message projection orders timestamps and bounds notices without dropping recent conversation', async t => {
  const h = fixture(t);
  atomicJson(join(h.root, 'runtime/view.json'), { version: 1, messages: [
    { id: 'notice:untimed-a', role: 'notice', content: 'Earlier untimed notice A' },
    { id: 'notice:untimed-b', role: 'notice', content: 'Earlier untimed notice B' },
    { id: 'notice:dated', role: 'notice', content: 'Earlier dated notice', at: '2026-01-02T07:00:00.000Z' },
  ] });
  let app = await h.openApp();
  let messageIds;
  try {
    const initial = await app.refresh();
    assert.deepEqual(initial.messages.map(message => message.id), [
      'notice:untimed-a', 'notice:untimed-b', 'notice:dated',
    ]);
    await app.send('Latest user message');
    const transcript = app.runtime.messages();
    const user = transcript.findLast(message => message.role === 'user');
    const assistant = transcript.findLast(message => message.role === 'assistant');
    await app.runtime.change(state => {
      for (let index = 0; index < 105; index++) {
        const id = `scheduled-${String(index).padStart(3, '0')}`;
        state.runs[id] = backgroundRun(id, {
          title: `Scheduled ${index}`,
          finishedAt: new Date(user.timestamp - 60000 + index).toISOString(),
        });
      }
    });
    const view = await app.refresh();
    messageIds = view.messages.map(message => message.id);
    const notices = view.messages.filter(message => message.role === 'notice');
    assert.equal(view.messages.length, 100);
    assert.equal(notices.length, 98);
    assert.equal(new Set(messageIds).size, messageIds.length);
    assert.deepEqual(view.messages.slice(-2).map(({ role, content, at }) => [role, content, at]), [
      ['user', 'Latest user message', user.timestamp],
      ['assistant', 'Reply: Latest user message', assistant.timestamp],
    ]);
    assert.deepEqual((await app.refresh()).messages.map(message => message.id), messageIds);
  } finally {
    await app.close();
  }

  app = await h.openApp();
  try {
    assert.deepEqual((await app.refresh()).messages.map(message => message.id), messageIds);
  } finally {
    await app.close();
  }
});

test('job activity is transient and quiet completion hands off exact saved Markdown', async t => {
  const h = fixture(t);
  const app = await h.openApp({ intervalMs: 60000 });
  t.after(() => app.close());
  await app.runtime.admit({ id: 'live', kind: 'background', scheduleId: 'check', title: 'Check' });
  await app.refresh();
  const files = ['runtime/view.json'];
  const before = files.map(file => readFileSync(join(h.root, file), 'utf8'));
  app.observeActivity('live', { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Preview' } });
  const view = await app.refresh();
  assert.equal(view.jobActivity.live[0].text, 'Preview');
  assert.deepEqual(files.map(file => readFileSync(join(h.root, file), 'utf8')), before);
  const durableBefore = await app.runtime.state();
  app.observeActivity('live', { type: 'response', data: 'SECRET' });
  await app.refresh();
  assert.deepEqual(await app.runtime.state(), durableBefore);
  app.onChange = null;
  await app.runtime.change(state => {
    for (let index = 0; index < 105; index++) state.runs[`newer-${index}`] = backgroundRun(`newer-${index}`, { startedAt: '2099-01-01T00:00:00Z' });
  });
  const body = '# Exact\n\nQuiet report.\n';
  await app.runtime.finish('live', { status: 'no_change', text: body });
  saveReport(h.root, 'live', body);
  await app.refresh();
  let notified;
  app.onChange = view => { notified = view; };
  const completed = await app.refresh();
  assert.equal(notified.completedJobReports.live.body, body);
  assert.equal(completed.completedJobReports.live.body, body);
  assert.equal(completed.completedJobReports.live.outcome, 'no_change');
  assert.equal(completed.reports.some(report => report.id === 'live'), false);
  assert.deepEqual(completed.jobActivity, {});
  assert.equal(app.jobActivity.size, 0);
  await app.runtime.admit({ id: 'unsaved', kind: 'background', scheduleId: 'check' });
  await app.refresh();
  await app.runtime.change(state => { state.runs.unsaved.status = 'failed'; });
  assert.equal((await app.refresh()).completedJobReports.unsaved, undefined);
});

test('event refresh during projection gets a follow-up instead of joining stale work', async t => {
  const app = Object.create(CompanionApplication.prototype);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const delivered = Promise.withResolvers();
  app.runner = {};
  let calls = 0;
  app.project = async () => {
    calls++;
    if (calls === 1) {
      entered.resolve();
      await release.promise;
    } else {
      delivered.resolve();
    }
  };
  const first = app.refresh();
  await entered.promise;
  app.requestRefresh();
  await new Promise(resolve => setTimeout(resolve, 40));
  release.resolve();
  await first;
  const lostRefresh = new Promise((_, reject) => {
    setTimeout(() => reject(Error('lost refresh')), 200);
  });
  await Promise.race([delivered.promise, lostRefresh]);
  assert.equal(calls, 2);
});

test('maximum-size reports stay file-backed outside the dashboard cache and are not replayed', { timeout: 10000 }, async t => {
  const h = fixture(t);
  const body = 'x'.repeat(16777216);
  const app = await h.openApp({ intervalMs: 60000 });
  t.after(async () => app.close());
  await app.runtime.admit({ id: 'large-report', kind: 'background', title: 'Large report' });
  await app.runtime.finish('large-report', { status: 'completed', text: body });
  assert.equal((await app.refresh()).reports.find(report => report.id === 'large-report').body, body);
  assert.equal(readFileSync(join(h.root, 'reports', readdirSync(join(h.root, 'reports'))[0]), 'utf8'), body);
  await app.close();
  assert.doesNotThrow(() => readLocalView(h.root));
  assert.ok(statSync(join(h.root, 'runtime/view.json')).size <= 16777216);
  assert.equal(readLocalView(h.root).reports.find(report => report.id === 'large-report').body, body);
  let calls = 0;
  const reopened = await h.openApp({ intervalMs: 60000, runHarness: async () => { calls++; throw Error('Unexpected report replay.'); } });
  t.after(async () => reopened.close());
  assert.equal((await reopened.refresh()).reports.find(report => report.id === 'large-report').body, body);
  assert.equal((await reopened.runtime.state()).runs['large-report'].status, 'completed');
  assert.equal(calls, 0);
  await reopened.close();
  assert.equal(calls, 0);
});
