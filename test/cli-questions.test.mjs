import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQuestionTool } from '../src/cli/questions.mjs';
import { CompanionApplication } from '../src/cli/application.mjs';
import { initialize } from '../src/cli/config.mjs';
import { openPiSession } from '../src/cli/pi-session.mjs';
import { isolatePiHome } from './helpers/pi-session.mjs';
import { createAgentSession, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createDashboard } from '../src/cli/ui.mjs';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

const question = {
  question: 'What should happen?',
  choices: [
    { value: 'keep', label: 'Keep paused' },
    { value: 'enable', label: 'Enable this schedule' },
  ],
};

test('question tool validates choices and returns only the exact selected answer or explicit non-answer', async () => {
  const execute = ask => createQuestionTool(ask).execute('q', question);
  assert.deepEqual((await execute(async () => 'keep')).details, { status: 'answered', answer: question.choices[0] });
  assert.equal((await execute(async () => null)).details.status, 'cancelled');
  assert.equal((await execute(undefined)).details.status, 'unavailable');
  await assert.rejects(execute(async () => 'forged'), /choice/i);
  for (const invalid of [
    { ...question, choices: [question.choices[0]] },
    { ...question, choices: [question.choices[0], question.choices[0]] },
    { ...question, question: '\x1b[2J' },
  ]) {
    await assert.rejects(createQuestionTool(() => { throw Error('Must not display'); }).execute('q', invalid), /Invalid question/);
  }
});

test('real SDK registers the main question tool and application delivers selection and cancellation to it', async t => {
  const root = mkdtempSync(join(tmpdir(), 'companion-questions-'));
  isolatePiHome(t, join(root, 'agent'));
  const config = initialize(root, { cwd: root });
  const ui = createDashboard({ config, connection: 'connected' });
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
  const models = await ModelRuntime.create({
    authPath: join(root, 'auth.json'),
    modelsPath: null,
    modelsStorePath: join(root, 'models.json'),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  models.getModel = () => model;
  models.streamSimple = () => { throw Error('No provider call allowed'); };
  let questionShown;
  const app = await CompanionApplication.open(root, {
    askQuestion: (request, signal) => {
      const pending = ui.askQuestion(request, signal);
      questionShown?.resolve();
      return pending;
    },
    createMain: options => openPiSession(options, {
      agentDir: join(root, 'agent'),
      createSession: options => createAgentSession({
        ...options,
        modelRuntime: models,
        model,
        agentDir: join(root, 'agent'),
        tools: ['ask_question'],
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      }),
    }),
  });
  t.after(async () => {
    ui.stop();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const tool = app.runtime.main.agent.state.tools.find(tool => tool.name === 'ask_question');
  assert.ok(tool, 'registered as a real SDK agent tool');
  ui.input('saved draft');
  const answered = tool.execute('choice-one', question);
  ui.input('\x1b[B');
  ui.input('\r');
  assert.deepEqual((await answered).details, { status: 'answered', answer: question.choices[1] });
  assert.equal(ui.state().draft, 'saved draft');
  const abort = new AbortController();
  const cancelled = tool.execute('choice-two', question, abort.signal);
  abort.abort();
  assert.equal((await cancelled).details.status, 'cancelled');
  models.hasConfiguredAuth = () => false;
  models.checkAuth = async () => ({ available: true });
  let toolId = 0;
  app.runtime.main.agent.streamFunction = (_model, context) => {
    const answered = context.messages.at(-1).role === 'toolResult';
    const message = {
      role: 'assistant',
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: answered ? [{ type: 'text', text: 'Received your selection.' }]
        : [{ type: 'toolCall', id: `ask-${++toolId}`, name: 'ask_question', arguments: question }],
      stopReason: answered ? 'stop' : 'toolUse',
      timestamp: Date.now(),
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
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
  questionShown = Promise.withResolvers();
  await app.send('Ask a question using the synthetic provider.');
  await questionShown.promise;
  ui.input('\r');
  await app.runtime.idle();
  const result = app.runtime.messages().find(message => message.role === 'toolResult');
  assert.deepEqual(JSON.parse(result.content[0].text), { status: 'answered', answer: question.choices[0] });
  questionShown = Promise.withResolvers();
  await app.runtime.send('Ask again, then cancel.', 'cancel-question');
  await questionShown.promise;
  await app.runtime.cancel('cancel-question');
  assert.equal((await app.runtime.state()).runs['cancel-question'].status, 'interrupted');
  assert.equal(ui.state().focus, 'composer');
  const closed = tool.execute('choice-three', question);
  ui.stop();
  assert.equal((await closed).details.status, 'cancelled');
});
