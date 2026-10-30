import test from 'node:test';
import assert from 'node:assert/strict';
import { migrationFixture } from './helpers/migration.mjs';
import { fakePi } from './helpers/pi-session.mjs';
import { runUpgrade } from '../src/cli/migration/cutover.mjs';
import { SchedulerCompatibility } from '../src/cli/legacy-engine.mjs';
import { CompanionRuntime } from '../src/cli/runtime.mjs';
import { CompanionRunner } from '../src/cli/runner.mjs';
import { CompatibilityDelivery } from '../src/cli/compatibility.mjs';
import { UsageLedger } from '../src/cli/usage.mjs';
import { loadConfig } from '../src/cli/config.mjs';

const directory = process.env.COMPANION_TEST_SCHEDULER;
const realEngine = { skip: directory ? false : 'Set COMPANION_TEST_SCHEDULER to the installed 0.5.1 package.' };

test('joined delivery runs shell wake, local notifications, messages and reflection with honest cost and evidence', realEngine, async t => {
  const h = await migrationFixture(t, {
    mutateTasks(tasks) {
      const base = tasks[0];
      tasks.push({ ...base, id: 'task_notify', action: 'notify', message: 'Local notice' });
      tasks.push({ ...base, id: 'task_message', action: 'message', message: 'Local context', triggerTurn: false });
      tasks.push({
        ...base,
        id: 'task_shell',
        action: 'shell',
        command: 'fixture-only',
        wakeOn: 'success',
        stopOn: 'success',
        followUpPrompt: 'Explain the output',
      });
    },
  });
  h.options.engine = SchedulerCompatibility.open(directory);
  await runUpgrade(h.journal, h.options);
  const config = loadConfig(h.root);
  const fake = fakePi(h.root);
  const runtime = await CompanionRuntime.open(h.root, config, { createMain: fake.createMain });
  await runtime.connect();
  const now = () => new Date(Date.parse(config.initializedAt) + 86400000);
  let shells = 0;
  let reviews = 0;
  const checks = [];
  const joined = new CompatibilityDelivery({
    root: runtime.directory,
    runtime,
    config,
    now,
    shell: async input => {
      shells++;
      assert.equal(input.command, 'fixture-only');
      return { stdout: 'Synthetic output', stderr: '', code: 0, killed: false };
    },
    runHarness: async input => {
      if (input.purpose === 'compatibility-check') {
        checks.push(input);
        return {
          status: 'completed', text: 'Scheduled result', sessionId: input.id, freshSession: true,
          model: input.model, effort: input.effort,
          cost: { usd: 0.25, sessionId: input.id, kind: 'estimate', cumulative: true },
        };
      }
      reviews++;
      assert.equal(input.purpose, 'reflection');
      return {
        status: 'completed',
        sessionId: input.id,
        freshSession: true,
        cost: { usd: 0.1, sessionId: input.id, kind: 'estimate', cumulative: true },
        text: JSON.stringify({ assessments: [], lessons: [], decisions: [], answers: [] }),
      };
    },
  });
  const runner = new CompanionRunner({ runtime, root: runtime.directory, config, compatibility: joined.adapter, now });
  t.after(async () => {
    await runner.stop();
    await joined.close();
    await runtime.close();
  });

  await runtime.send('Prefer a weekly summary', 'user-input');
  await runtime.idle();
  for (let i = 0; i < 7; i++) {
    await joined.syncEvidence();
    await runner.tick();
    await runtime.idle();
  }
  await joined.syncEvidence();

  const state = await runtime.state();
  const runs = Object.values(state.runs);
  assert.equal(shells, 1);
  assert.equal(reviews, 1);
  assert.equal(checks.length, 2);
  const shellCheck = checks.find(input => input.prompt.includes('Synthetic output'));
  assert.equal(JSON.parse(shellCheck.prompt).followUp, 'Explain the output');
  assert.ok(runs.some(run => run.result?.text === 'Local context' && run.result.noModel && run.result.cost === null));
  for (const run of runs.filter(run => run.legacy && run.result?.freshSession)) {
    assert.notEqual(run.result.sessionId, run.sessionId);
    assert.equal(run.harnessId, run.sessionId);
  }
  assert.ok(runs.some(run => run.result?.text === 'Local notice' && run.result.noModel));
  assert.ok(runs.some(run => run.result?.compatibilityTask?.id === 'task_shell' && run.result.compatibilityTask.enabled === false));
  const memory = state.reflections[h.options.sessions[0].origin];
  assert.equal(memory.evidence.filter(item => item.kind === 'user' && item.text === 'Prefer a weekly summary').length, 1, JSON.stringify(state.reflections));
  assert.ok(memory.evidence.some(item => item.kind === 'outcome'));
  assert.equal(memory.evidence.some(item => item.kind === 'user' && item.text.includes('Synthetic output')), false);
  const usage = UsageLedger.open(runtime.directory, config.initializedAt).sync(state);
  assert.equal(usage.usd, 0.85);
  assert.deepEqual(usage.issues, {});
  assert.equal(fake.controls.get(runtime.main.sessionId).calls, 1);
});

test('main input during legacy preparation proceeds independently', realEngine, async t => {
  const h = await migrationFixture(t, {
    mutateState: state => { delete state.experience.wake; },
    mutateTasks: tasks => { tasks.splice(1); },
  });
  h.options.engine = SchedulerCompatibility.open(directory);
  await runUpgrade(h.journal, h.options);
  const config = loadConfig(h.root);
  const fake = fakePi(h.root);
  const runtime = await CompanionRuntime.open(h.root, config, { createMain: fake.createMain });
  await runtime.connect();
  const now = () => new Date(Date.parse(config.initializedAt) + 86400000);
  let checks = 0;
  const joined = new CompatibilityDelivery({ root: runtime.directory, runtime, config, now, runHarness: async input => {
    checks++;
    return { status: 'completed', text: 'Independent check', sessionId: input.id, freshSession: true, cost: null };
  } });
  const runner = new CompanionRunner({ runtime, root: runtime.directory, config, compatibility: joined.adapter, now });
  const prepared = Promise.withResolvers();
  const resumePreparation = Promise.withResolvers();
  const prepare = joined.adapter.prepare.bind(joined.adapter);
  joined.adapter.prepare = async (...args) => {
    const result = await prepare(...args);
    prepared.resolve();
    await resumePreparation.promise;
    return result;
  };
  const control = fake.controls.get(runtime.main.sessionId);
  control.gate = Promise.withResolvers();
  t.after(async () => {
    resumePreparation.resolve();
    control.gate.resolve();
    await runner.stop();
    await joined.close();
    await runtime.close();
  });

  const ticking = runner.tick();
  await prepared.promise;
  await runtime.send('User input wins', 'user-first');
  resumePreparation.resolve();
  await ticking;
  await Promise.all([...runner.jobs.values()]);
  const first = Object.values((await runtime.state()).runs).filter(run => run.legacy);
  assert.equal(first.length, 1);
  assert.equal(first[0].status, 'completed');
  assert.equal(checks, 1);

  control.gate.resolve();
  await runtime.idle();
  await runtime.send('Later main input');
  await runtime.idle();
  assert.equal(first[0].harnessId, runtime.main.sessionId);
  assert.notEqual(first[0].result.sessionId, runtime.main.sessionId);
  assert.ok(first[0].result.compatibilityTask);
  assert.equal(control.calls, 2);
  assert.equal(checks, 1);
  assert.equal(runner.loaded.errors.length, 0);
});

test('host no-model receipts are excluded; missing model costs retain their reason', async t => {
  const h = await migrationFixture(t);
  const ledger = UsageLedger.open(h.root, h.options.config.initializedAt);
  const state = {
    runs: {
      local: { id: 'local', status: 'completed', result: { noModel: true, cost: null } },
      quiet: { id: 'quiet', status: 'no_change', result: { noModel: true, cost: null } },
      missing: { id: 'missing', harness: 'pi', status: 'incomplete', result: { cost: null } },
    },
  };
  assert.deepEqual(ledger.sync(state).issues, { missing_or_mismatched_cost: 1 });
  assert.deepEqual(ledger.sync(state).issues, { missing_or_mismatched_cost: 1 });
});
