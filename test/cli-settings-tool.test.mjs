import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { atomicJson, initialize } from '../src/cli/config.mjs';
import { openPiSession } from '../src/cli/pi-session.mjs';
import { readSettings } from '../src/cli/settings.mjs';

function model(id, thinkingLevelMap) {
  return {
    id,
    name: id,
    provider: 'fixture',
    api: 'openai-completions',
    baseUrl: 'https://invalid.test',
    reasoning: true,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input: ['text'],
    contextWindow: 32000,
    maxTokens: 2048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function schedule(root) {
  const path = join(root, 'schedules/daily/daily-check.md');
  const metadata = {
    id: 'daily-check', title: 'Daily check', at: '09:00', timezone: 'UTC', enabled: false,
    harness: 'pi', model: 'fixture/old', effort: 'medium', cwd: root, context: [],
  };
  writeFileSync(path, `---\n${JSON.stringify(metadata, null, 2)}\n---\nCheck synthetic data.\n`);
  return path;
}

function emitTurn(session, responses, observations) {
  let index = 0;
  session.agent.streamFunction = (selectedModel, _context, options) => {
    observations.push({
      model: `${selectedModel.provider}/${selectedModel.id}`,
      effort: options.reasoning ?? 'off',
    });
    const request = responses[index++];
    const message = {
      role: 'assistant',
      api: selectedModel.api,
      provider: selectedModel.provider,
      model: selectedModel.id,
      content: request
        ? [{ type: 'toolCall', id: `settings-${index}`, name: 'model_settings', arguments: request }]
        : [{ type: 'text', text: 'Settings checked.' }],
      stopReason: request ? 'toolUse' : 'stop',
      timestamp: Date.now(),
      usage: {
        input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: 'done', reason: message.stopReason, message });
      stream.end();
    });
    return stream;
  };
}

function receipts(session) {
  return session.messages.filter(message => message.role === 'toolResult')
    .map(message => JSON.parse(message.content[0].text));
}

async function syntheticRuntime(root, models) {
  const modelRuntime = await ModelRuntime.create({
    authPath: join(root, 'auth.json'),
    modelsPath: null,
    modelsStorePath: join(root, 'models.json'),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider('fixture', {
    name: 'Synthetic fixture provider',
    api: 'openai-completions',
    baseUrl: 'https://invalid.test',
    apiKey: 'synthetic',
    streamSimple: () => { throw Error('Synthetic tests never call a provider.'); },
    models: models.map(({ provider, ...entry }) => entry),
  });
  return modelRuntime;
}

test('SDK model settings tool persists exact scopes, updates the active session, and reports SDK clamping', async t => {
  const root = mkdtempSync(join(tmpdir(), 'companion-settings-tool-'));
  const config = initialize(root, { cwd: root });
  const schedulePath = schedule(root);
  const agentDir = join(root, 'agent');
  const oldModel = model('old');
  const nextModel = model('next');
  let session;
  t.after(() => {
    session?.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  const modelRuntime = await syntheticRuntime(root, [oldModel, nextModel]);

  const tools = ['ask_question', 'run_schedule', 'model_settings'];
  const createSession = options => createAgentSession({
    ...options,
    modelRuntime,
    model: options.model ?? oldModel,
    agentDir,
    tools,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
  });
  const open = () => openPiSession({
    root,
    config,
    askQuestion: async () => undefined,
    triggerSchedule: async () => ({ status: 'synthetic' }),
  }, { agentDir, modelRuntime, createSession });

  session = await open();
  const toolNames = session.agent.state.tools.map(tool => tool.name);
  for (const name of tools) assert.ok(toolNames.includes(name), `${name} remains registered`);
  const inspect = session.agent.state.tools.find(tool => tool.name === 'model_settings');
  const initialInspection = (await inspect.execute('inspect', { action: 'inspect', scope: 'main' })).details;
  assert.equal(initialInspection.settings.main.model, null);
  assert.deepEqual(initialInspection.activeMainBinding, { model: 'fixture/old', effort: 'medium' });
  assert.deepEqual(initialInspection.availableModels.filter(name => name.startsWith('fixture/')), ['fixture/next', 'fixture/old']);

  const observations = [];
  emitTurn(session, [{
    action: 'update', scope: 'all', model: 'fixture/next', effort: 'high',
  }], observations);
  await session.prompt('Set the shared synthetic binding.', { preflightResult() {} });

  const firstReceipt = receipts(session)[0];
  assert.equal(firstReceipt.persisted.status, 'complete');
  assert.deepEqual(firstReceipt.activeRuntime, {
    status: 'verified', effective: { model: 'fixture/next', effort: 'high' },
  });
  assert.equal(readSettings(root, 'all').schedules[0].model, 'fixture/next');
  assert.equal(config.background.model, 'fixture/next');
  assert.deepEqual(observations, [
    { model: 'fixture/old', effort: 'medium' },
    { model: 'fixture/next', effort: 'high' },
  ]);

  session.dispose();
  session = await open();
  assert.equal(session.model.provider, 'fixture');
  assert.equal(session.model.id, 'next');
  assert.equal(session.thinkingLevel, 'high');
  for (const name of tools) assert.ok(session.agent.state.tools.some(tool => tool.name === name));
  const currentInspect = session.agent.state.tools.find(tool => tool.name === 'model_settings');

  const continued = [];
  emitTurn(session, [{ action: 'update', scope: 'main', effort: 'xhigh' }], continued);
  await session.prompt('Request an unsupported synthetic effort.', { preflightResult() {} });

  const finalReceipt = receipts(session).at(-1);
  assert.deepEqual(finalReceipt.activeRuntime, {
    status: 'unverified', effective: { model: 'fixture/next', effort: 'high' },
  });
  assert.equal(readSettings(root, 'main').main.effort, 'xhigh');
  const clampedInspection = (await currentInspect.execute('inspect', { action: 'inspect', scope: 'main' })).details;
  assert.equal(clampedInspection.settings.main.effort, 'xhigh');
  assert.deepEqual(clampedInspection.activeMainBinding, { model: 'fixture/next', effort: 'high' });
  assert.deepEqual(continued, [
    { model: 'fixture/next', effort: 'high' },
    { model: 'fixture/next', effort: 'high' },
  ]);

  // The saved level stays what the user asked for, so it returns on a model that supports it.
  session.dispose();
  session = await open();
  assert.equal(session.thinkingLevel, 'high');
});

test('a request for one schedule changes that schedule through the settings tool', async t => {
  const root = mkdtempSync(join(tmpdir(), 'companion-settings-tool-'));
  const config = initialize(root, { cwd: root });
  schedule(root);
  const agentDir = join(root, 'agent');
  const oldModel = model('old');
  let session;
  t.after(() => {
    session?.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  const modelRuntime = await syntheticRuntime(root, [oldModel]);
  session = await openPiSession({ root, config, askQuestion: async () => undefined, triggerSchedule: async () => ({}) }, {
    agentDir,
    modelRuntime,
    createSession: options => createAgentSession({
      ...options,
      modelRuntime,
      model: oldModel,
      agentDir,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    }),
  });
  const tool = session.agent.state.tools.find(item => item.name === 'model_settings');

  const { details } = await tool.execute('update', { action: 'update', scope: 'schedules', scheduleId: 'daily-check', effort: 'high' });

  assert.deepEqual(details.persisted.completed, ['schedules:daily-check']);
  assert.equal(readSettings(root, 'schedules').schedules[0].effort, 'high');
  assert.equal(session.thinkingLevel, 'medium');

  const rejected = (await tool.execute('update', { action: 'update', scope: 'schedules', scheduleId: 'missing', effort: 'low' })).details;
  assert.equal(rejected.persisted.status, 'failed');
  assert.match(rejected.persisted.failed.error, /Unknown schedule: missing/);
});
