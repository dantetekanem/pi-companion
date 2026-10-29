import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanionRuntime } from '../src/cli/runtime.mjs';
import { openPiSession } from '../src/cli/pi-session.mjs';
import { initialize } from '../src/cli/config.mjs';
import { readReport } from '../src/cli/reports.mjs';

function home(t) {
  const root = mkdtempSync(join(tmpdir(), 'companion-runtime-'));
  const config = initialize(root, { cwd: root });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, config };
}
function mainFactory(control = {}) {
  return async options => openPiSession(options, {
    agentDir: join(options.root, 'pi-agent'),
    createSession: async ({ sessionManager, resourceLoader }) => {
      control.resources = resourceLoader;
      const listeners = new Set();
      const session = {
        sessionId: sessionManager.getSessionId(),
        sessionFile: sessionManager.getSessionFile(),
        model: { provider: 'fake', id: 'local' },
        thinkingLevel: 'medium',
        get messages() { return sessionManager.buildSessionContext().messages; },
        subscribe(callback) {
          listeners.add(callback);
          return () => listeners.delete(callback);
        },
        getSessionStats() {
          return {
            sessionId: this.sessionId,
            cost: this.messages.filter(message => message.role === 'assistant').length * 0.5,
          };
        },
        async prompt(text, options) {
          control.calls = (control.calls ?? 0) + 1;
          if (control.reject) {
            options.preflightResult(false);
            throw Error('Rejected before dispatch');
          }
          sessionManager.appendMessage({ role: 'user', content: text, timestamp: Date.now() });
          options.preflightResult(true);
          if (control.gate) await control.gate.promise;
          if (control.aborted) throw Error('Aborted');
          sessionManager.appendMessage({
            role: 'assistant',
            content: [{ type: 'text', text: `Reply: ${text}` }],
            timestamp: Date.now(),
            stopReason: 'stop',
            usage: { cost: { total: 0.5 } },
          });
          for (const callback of listeners) callback({ type: 'agent_settled' });
        },
        async abort() {
          control.aborted = true;
          control.gate?.resolve();
        },
        dispose() { control.disposed = true; },
      };
      return { session };
    },
  });
}

test('main SDK receives Companion context and ordinary project resources without extensions or an initial model turn', async t => {
  const { root, config } = home(t);
  const control = {};
  writeFileSync(join(root, 'AGENTS.md'), 'Synthetic local context');
  const runtime = await CompanionRuntime.open(root, config, { createMain: mainFactory(control) });
  try {
    await runtime.connect();
    assert.ok(control.resources.getAppendSystemPrompt().length > 0);
    assert.ok(control.resources.getAgentsFiles().agentsFiles.some(file => file.path === join(root, 'AGENTS.md')));
    assert.deepEqual(control.resources.getExtensions().extensions, []);
    assert.equal(control.calls, undefined);
  } finally {
    await runtime.close();
  }
});

test('real Durable reserves before effects, rejects concurrent owners, and reopens without replaying uncertain work', async t => {
  const { root, config } = home(t);
  const runtime = await CompanionRuntime.open(root, config, { createMain: mainFactory() });
  await assert.rejects(CompanionRuntime.open(root, config), /already running/);
  assert.equal(await runtime.admit({ id: 'job:1', kind: 'background', title: 'Check' }), true);
  assert.equal(await runtime.admit({ id: 'job:1', kind: 'background', title: 'Check' }), false);
  await runtime.close();
  const reopened = await CompanionRuntime.open(root, config, { createMain: mainFactory() });
  try {
    const state = await reopened.state();
    assert.equal(state.runs['job:1'].status, 'interrupted');
    assert.equal(state.runs['job:1'].cost, null);
    assert.equal(await reopened.admit({ id: 'job:1', kind: 'background' }), false);
    assert.equal(statSync(join(root, 'runtime', 'companion.sqlite')).mode & 0o777, 0o600);
  } finally {
    await reopened.close();
  }
});

test('the main Pi identity and conversation survive reconnect; initialization makes no prompt calls', async t => {
  const { root, config } = home(t);
  const control = {};
  let runtime = await CompanionRuntime.open(root, config, { createMain: mainFactory(control) });
  await runtime.connect();
  const identity = (await runtime.state()).main;
  assert.equal(control.calls, undefined);
  await runtime.send('hello', 'message:1');
  await runtime.idle();
  assert.equal((await runtime.state()).runs['message:1'].status, 'completed');
  assert.equal((await runtime.state()).runs['message:1'].cost.usd, 0.5);
  await runtime.close();
  runtime = await CompanionRuntime.open(root, config, { createMain: mainFactory(control) });
  try {
    await runtime.connect();
    assert.equal((await runtime.state()).main.sessionId, identity.sessionId);
    assert.equal(runtime.messages()[0].content, 'hello');
    assert.equal(control.calls, 1);
    await assert.rejects(runtime.send('hello', 'message:1'), /already admitted/);
  } finally {
    await runtime.close();
  }
});

test('acceptance returns before the model; cancellation records uncertainty and never submits again', async t => {
  const { root, config } = home(t);
  const control = { gate: Promise.withResolvers() };
  const runtime = await CompanionRuntime.open(root, config, { createMain: mainFactory(control) });
  await runtime.connect();
  await runtime.send('slow', 'message:2');
  assert.equal((await runtime.state()).runs['message:2'].status, 'running');
  await assert.rejects(runtime.send('not queued'), /busy/);
  await runtime.close();
  const reopened = await CompanionRuntime.open(root, config, { createMain: mainFactory() });
  try {
    assert.equal((await reopened.state()).runs['message:2'].status, 'interrupted');
    assert.equal(control.calls, 1);
    assert.equal(control.disposed, true);
  } finally {
    await reopened.close();
  }
});

test('rejected main input retains a failed receipt and the caller receives a send error', async t => {
  const { root, config } = home(t);
  const control = { reject: true };
  const runtime = await CompanionRuntime.open(root, config, { createMain: mainFactory(control) });
  try {
    await runtime.connect();
    await assert.rejects(runtime.send('rejected', 'message:3'), /rejected/i);
    await runtime.idle();
    assert.equal((await runtime.state()).runs['message:3'].status, 'failed');
    assert.equal((await runtime.state()).runs['message:3'].result.noModel, true);
    assert.equal(runtime.messages().length, 0);
  } finally {
    await runtime.close();
  }
});

test('shutdown drains dispatch admission before releasing the storage owner', async t => {
  const { root, config } = home(t);
  const runtime = await CompanionRuntime.open(root, config, { createMain: mainFactory() });
  let calls = 0;
  const pending = runtime.dispatch({ id: 'job:closing', kind: 'background' }, async () => {
    calls++;
    return { status: 'completed' };
  });
  const observed = pending.catch(error => error);
  await runtime.close();
  await observed;
  assert.equal(calls, 0);
  const reopened = await CompanionRuntime.open(root, config, { createMain: mainFactory() });
  await reopened.close();
});

test('background dispatch commits final receipts once and a second call cannot repeat its effect', async t => {
  const { root, config } = home(t);
  const runtime = await CompanionRuntime.open(root, config, { createMain: mainFactory() });
  let calls = 0;
  const effect = async () => {
    calls++;
    assert.equal((await runtime.state()).runs['job:2'].status, 'running');
    return { status: 'completed', text: 'No changes', cost: null };
  };
  try {
    await runtime.dispatch({ id: 'job:2', kind: 'background' }, effect);
    await runtime.dispatch({ id: 'job:2', kind: 'background' }, effect);
    assert.equal(calls, 1);
    assert.equal((await runtime.state()).runs['job:2'].status, 'completed');
    assert.equal(readReport(root, 'job:2'), 'No changes');
    await assert.rejects(runtime.finish('job:2', { status: 'failed', text: 'changed' }), /conflicting/);
    await runtime.dispatch({ id: 'job:failure', kind: 'background' }, async () => ({
      status: 'failed', text: '# Partial evidence\n\nCollected before failure.', error: 'Tool failed',
    }));
    const failureRun = (await runtime.state()).runs['job:failure'];
    assert.equal(failureRun.status, 'failed');
    assert.equal(failureRun.cost, null);
    assert.equal(readReport(root, 'job:failure'), '# Partial evidence\n\nCollected before failure.\n\n---\n\n**Execution failure:** Tool failed');
    await runtime.admit({ id: 'job:unsaved', kind: 'background' });
    await assert.rejects(runtime.finish('job:unsaved', { status: 'completed', text: 'x'.repeat(16777217) }), /bounded/);
    assert.equal((await runtime.state()).runs['job:unsaved'].status, 'running');
  } finally {
    await runtime.close();
  }
});
