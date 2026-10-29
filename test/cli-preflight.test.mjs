import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { initialize } from '../src/cli/config.mjs';
import { openPiSession } from '../src/cli/pi-session.mjs';
import { CompanionRuntime } from '../src/cli/runtime.mjs';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { UsageLedger } from '../src/cli/usage.mjs';
import { CompanionApplication } from '../src/cli/application.mjs';

// Real SDK preflight and Agent lifecycle; authentication and provider submission are synthetic.
async function fixture(t, { history = false, application = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'companion-preflight-'));
  const config = initialize(root, { cwd: root });
  const authStarted = Promise.withResolvers();
  const releaseAuth = Promise.withResolvers();
  let submissions = 0;
  let toolCalls = 0;
  const model = {
    id: 'local',
    name: 'Synthetic',
    provider: 'fixture',
    api: 'openai-completions',
    baseUrl: 'https://invalid.test',
    reasoning: true,
    input: ['text'],
    contextWindow: 32000,
    maxTokens: 2048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const modelRuntime = await ModelRuntime.create({
    authPath: join(root, 'auth.json'),
    modelsPath: null,
    modelsStorePath: join(root, 'models.json'),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.getModel = () => model;
  modelRuntime.hasConfiguredAuth = () => false;
  modelRuntime.checkAuth = async () => {
    authStarted.resolve();
    await releaseAuth.promise;
    return { available: true };
  };
  modelRuntime.streamSimple = () => {
    submissions++;
    throw Error('Synthetic provider boundary reached');
  };
  const createMain = options => openPiSession(options, {
    agentDir: join(root, 'agent'),
    createSession: async sdkOptions => {
      const result = await createAgentSession({
        ...sdkOptions,
        agentDir: join(root, 'agent'),
        modelRuntime,
        model,
        tools: [],
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: history, reserveTokens: 2000, keepRecentTokens: 100 },
          retry: { enabled: false },
        }),
      });
      if (history) {
        for (let index = 0; index < 4; index++) {
          sdkOptions.sessionManager.appendMessage({
            role: 'user',
            content: 'Saved context '.repeat(100),
            timestamp: index * 2,
          });
          sdkOptions.sessionManager.appendMessage({
            role: 'assistant',
            provider: model.provider,
            model: model.id,
            content: [{ type: 'text', text: 'Saved response '.repeat(100) }],
            stopReason: 'stop',
            timestamp: index * 2 + 1,
            usage: {
              input: 31000,
              output: 100,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 31100,
              cost: { total: 0 },
            },
          });
        }
        result.session.agent.state.messages = sdkOptions.sessionManager.buildSessionContext().messages;
      }
      return result;
    },
  });
  const app = application ? await CompanionApplication.open(root, { createMain }) : null;
  const runtime = app?.runtime ?? await CompanionRuntime.open(root, config, { createMain });
  await runtime.connect();
  runtime.main.subscribe(event => {
    if (event.type === 'tool_execution_start') toolCalls++;
  });
  t.after(async () => {
    releaseAuth.resolve();
    if (app) await app.close();
    else await runtime.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    config,
    runtime,
    app,
    authStarted,
    releaseAuth,
    calls: () => ({ submissions, toolCalls }),
  };
}

test('real SDK automatic compaction tracks context, keeps history and accounts summary cost', async t => {
  const finish = Promise.withResolvers();
  t.after(() => finish.resolve());
  const h = await fixture(t, { history: true, application: true });
  const main = h.runtime.main;
  const previousIds = main.sessionManager.getEntries().map(entry => entry.id);
  const started = Promise.withResolvers();
  let calls = 0;
  main.agent.streamFunction = model => {
    calls++;
    const stream = createAssistantMessageEventStream();
    started.resolve();
    finish.promise.then(() => {
      const message = {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [{ type: 'text', text: 'Summary of synthetic history.' }],
        stopReason: 'stop',
        timestamp: Date.now(),
        usage: {
          input: 100,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 120,
          cost: { input: 0.2, output: 0.05, cacheRead: 0, cacheWrite: 0, total: 0.25 },
        },
      };
      stream.push({ type: 'done', reason: 'stop', message });
      stream.end();
    });
    return stream;
  };
  h.releaseAuth.resolve();
  const work = h.app.send('Continue synthetic work');
  await started.promise;
  const during = await h.app.refresh();
  assert.equal(during.context.compacting, true);
  assert.equal(during.context.auto, true);
  assert.equal(during.context.contextWindow, 32000);
  assert.equal(h.runtime.mainBusy, true);
  finish.resolve();
  await work;
  await h.runtime.idle();
  const after = await h.app.refresh();
  assert.equal(after.context.compacting, false);
  assert.equal(after.context.compactions, 1);
  assert.equal(after.context.last.status, 'completed');
  assert.equal(after.context.tokens, 120);
  // The small keepRecentTokens fixture splits a turn: history + turn-prefix summaries.
  assert.equal(after.usage.usd, 0.75);
  assert.equal(calls, 3);
  assert.ok(previousIds.every(id => main.sessionManager.getEntries().some(entry => entry.id === id)));
  const state = await h.runtime.state();
  assert.equal(UsageLedger.open(h.root, h.config.initializedAt).sync(state).usd, after.usage.usd);
});

for (const [action, history] of [['cancel', false], ['close', false], ['close', true]]) {
  test(`main ${action} during SDK preflight prevents submission${history ? ' with compaction due' : ''}`, async t => {
    const h = await fixture(t, { history });
    const originalStream = h.runtime.main.agent.streamFunction;
    const sent = h.runtime.send('Do not submit after cancellation', 'preflight').then(
      () => ({ accepted: true }),
      error => ({ accepted: false, error }),
    );
    await h.authStarted.promise;
    const stopping = action === 'close' ? h.runtime.close() : h.runtime.cancel('preflight');
    h.releaseAuth.resolve();
    await stopping;

    assert.equal((await sent).accepted, false);
    assert.deepEqual(h.calls(), { submissions: 0, toolCalls: 0 });
    assert.equal(h.runtime.main.agent.streamFunction, originalStream);
    if (action === 'close') {
      const reopened = await CompanionRuntime.open(h.root, h.config);
      try {
        assert.equal((await reopened.state()).runs.preflight.status, 'interrupted');
      } finally {
        await reopened.close();
      }
    } else {
      assert.equal((await h.runtime.state()).runs.preflight.status, 'interrupted');
      await h.runtime.send('A later explicitly requested turn', 'after-cancel');
      await h.runtime.idle();
      assert.equal(h.calls().submissions, 1);
    }
  });
}

