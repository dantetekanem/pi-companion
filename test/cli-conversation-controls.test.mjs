import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { initialize } from '../src/cli/config.mjs';
import { openPiSession } from '../src/cli/pi-session.mjs';
import { CompanionRuntime } from '../src/cli/runtime.mjs';
import { UsageLedger } from '../src/cli/usage.mjs';

// Real SDK, session storage and Durable; no authentication/network or executable external tools.
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'companion-controls-'));
  const config = initialize(root, { cwd: root });
  const model = {
    id: 'local', provider: 'fixture', name: 'Synthetic', api: 'openai-completions',
    baseUrl: 'https://invalid.test', reasoning: true, input: ['text'],
    contextWindow: 32000, maxTokens: 2048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const models = await ModelRuntime.create({
    authPath: join(root, 'auth.json'), modelsPath: null,
    modelsStorePath: join(root, 'models.json'), allowModelNetwork: false, refreshOnCreate: false,
  });
  models.hasConfiguredAuth = () => true;
  const calls = [];
  let waiting;
  const pending = [];
  const createMain = options => openPiSession(options, {
    agentDir: join(root, 'agent'),
    createSession: async sdkOptions => {
      const result = await createAgentSession({
        ...sdkOptions, agentDir: join(root, 'agent'), modelRuntime: models, model, tools: [],
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      });
      result.session.agent.streamFunction = (selected, context, { signal }) => {
        const stream = createAssistantMessageEventStream();
        let settled = false;
        const finish = (text = 'Synthetic reply', aborted = false) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', abort);
          const message = {
            role: 'assistant', api: selected.api, provider: selected.provider, model: selected.id,
            content: [{ type: 'text', text }], stopReason: aborted ? 'aborted' : 'stop', timestamp: Date.now(),
            usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120,
              cost: { input: 0.2, output: 0.05, cacheRead: 0, cacheWrite: 0, total: 0.25 } },
          };
          stream.push(aborted ? { type: 'error', reason: 'aborted', error: message }
            : { type: 'done', reason: 'stop', message });
          stream.end();
        };
        const abort = () => finish('Cancelled', true);
        signal?.addEventListener('abort', abort, { once: true });
        const call = { messages: structuredClone(context.messages), finish };
        calls.push(call);
        if (waiting) { waiting.resolve(call); waiting = null; }
        else pending.push(call);
        if (signal?.aborted) abort();
        return stream;
      };
      return result;
    },
  });
  const runtime = await CompanionRuntime.open(root, config, { createMain });
  await runtime.connect();
  t.after(async () => { await runtime.close(); rmSync(root, { recursive: true, force: true }); });
  return {
    root, config, runtime, createMain, calls,
    nextCall() {
      if (pending.length) return Promise.resolve(pending.shift());
      waiting = Promise.withResolvers();
      return waiting.promise;
    },
  };
}

const text = messages => messages.filter(message => message.role === 'user')
  .map(message => typeof message.content === 'string' ? message.content : message.content.map(part => part.text).join(''));

test('owned main turns accept native steering once without another reservation or duplicated cost', async t => {
  const h = await fixture(t);
  await h.runtime.send('Original request', 'original');
  const first = await h.nextCall();
  const queued = await h.runtime.send('Use the corrected scope', 'correction');
  assert.equal(queued.queued, true);
  await h.runtime.send('Use the corrected scope', 'correction');
  first.finish();
  const second = await h.nextCall();
  assert.deepEqual(text(second.messages), ['Original request', 'Use the corrected scope']);
  second.finish();
  await h.runtime.idle();
  assert.equal(h.calls.length, 2);
  const state = await h.runtime.state();
  assert.equal(state.runs.correction.parentRunId, 'original');
  assert.equal(UsageLedger.open(h.root, h.config.initializedAt).sync(state).usd, 0.5);
  const release = h.runtime.reserveSession(h.runtime.main.sessionId);
  try {
    await assert.rejects(h.runtime.send('Do not steer a migrated delivery'), /busy/i);
    await assert.rejects(h.runtime.reset(), /busy/i);
  } finally { release(); }
});

test('reset preserves transcript, accounting and background work but reopens with a fresh empty main', async t => {
  const h = await fixture(t);
  await h.runtime.send('Remember only in the old context', 'old');
  (await h.nextCall()).finish();
  await h.runtime.idle();
  const old = (await h.runtime.state()).main;
  const bytes = readFileSync(old.sessionFile);
  const previousTools = h.runtime.main.getActiveToolNames();
  const backgroundStarted = Promise.withResolvers();
  const releaseBackground = Promise.withResolvers();
  const background = h.runtime.dispatch({ id: 'background', kind: 'background' }, async signal => {
    signal.addEventListener('abort', () => releaseBackground.resolve(), { once: true });
    backgroundStarted.resolve();
    await releaseBackground.promise;
    return { status: 'no_change', noModel: true };
  });
  t.after(() => releaseBackground.resolve());
  await backgroundStarted.promise;
  const reset = await h.runtime.reset();
  assert.notEqual(reset.sessionId, old.sessionId);
  assert.equal(await h.runtime.connect(), h.runtime.main);
  assert.equal(h.runtime.messages().length, 0);
  assert.deepEqual(h.runtime.main.getActiveToolNames(), previousTools);
  assert.deepEqual(readFileSync(old.sessionFile), bytes);
  const state = await h.runtime.state();
  assert.equal(state.runs.background.status, 'running');
  assert.equal(UsageLedger.open(h.root, h.config.initializedAt).sync(state).usd, 0.25);
  assert.equal(h.calls.length, 1);
  releaseBackground.resolve();
  await background;
  await h.runtime.close();
  const reopened = await CompanionRuntime.open(h.root, h.config, { createMain: h.createMain });
  try {
    await reopened.connect();
    assert.equal(reopened.main.sessionId, reset.sessionId);
    assert.equal(reopened.messages().length, 0);
    assert.equal(UsageLedger.open(h.root, h.config.initializedAt).sync(await reopened.state()).usd, 0.25);
    await reopened.send('Fresh request', 'fresh');
    const call = await h.nextCall();
    assert.deepEqual(text(call.messages), ['Fresh request']);
    call.finish();
    await reopened.idle();
  } finally { await reopened.close(); }
});

test('a failed reset leaves the previous main identity and transcript usable', async t => {
  const h = await fixture(t);
  await h.runtime.send('Keep the saved conversation', 'before-reset');
  const first = await h.nextCall();
  first.finish('Saved answer');
  await h.runtime.idle();

  const previous = h.runtime.main;
  const previousState = await h.runtime.state();
  const previousBytes = readFileSync(previous.sessionFile);
  const createMain = h.runtime.createMain;
  h.runtime.createMain = options => options.fresh
    ? Promise.reject(Error('Synthetic reset failure'))
    : createMain(options);

  await assert.rejects(h.runtime.reset(), /Synthetic reset failure/);
  assert.equal(h.runtime.main, previous);
  assert.equal((await h.runtime.state()).main.sessionId, previousState.main.sessionId);
  assert.deepEqual(readFileSync(previous.sessionFile), previousBytes);
  assert.deepEqual(text(h.runtime.messages()), ['Keep the saved conversation']);

  await h.runtime.send('Continue the old context', 'after-reset-failure');
  const continued = await h.nextCall();
  assert.deepEqual(text(continued.messages), ['Keep the saved conversation', 'Continue the old context']);
  continued.finish();
  await h.runtime.idle();
});

test('reset aborts the owned stream, discards queued steering and rejects input during the transition', async t => {
  const h = await fixture(t);
  await h.runtime.send('Old request', 'old');
  await h.nextCall();
  await h.runtime.send('Queued old correction', 'queued');
  const reset = h.runtime.reset();
  await assert.rejects(h.runtime.send('Not during reset'), /reset/i);
  await reset;
  assert.equal((await h.runtime.state()).runs.old.status, 'interrupted');
  assert.equal(h.runtime.messages().length, 0);
  await h.runtime.send('New request', 'new');
  const call = await h.nextCall();
  assert.deepEqual(text(call.messages), ['New request']);
  call.finish();
  await h.runtime.idle();
});
