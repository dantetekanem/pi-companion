import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJson, initialize } from '../src/cli/config.mjs';
import { closePiSession, openImportedPiSession, openPiSession } from '../src/cli/pi-session.mjs';
import { extensionPath } from '../src/cli/rpc-session.mjs';
import { CompanionRuntime } from '../src/cli/runtime.mjs';
import { dialog, fakePiRpc } from './helpers/fake-rpc-pi.mjs';

const launcher = { command: ['my-pi-launcher', 'pi'], env: { EXAMPLE_MODE: '1' }, managedExtensions: true };

async function until(condition, message = 'condition') {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw Error(`Timed out waiting for ${message}`);
    await new Promise(resolve => setImmediate(resolve));
  }
}

function fixture(t, pi = {}, options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'companion-rpc-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = initialize(root, { cwd: root, now: '2026-01-01T00:00:00Z' });
  config.main = { cwd: root, model: 'fixture/local', effort: 'medium' };
  config.launcher = launcher;
  atomicJson(join(root, 'config.json'), config);
  const fake = fakePiRpc(pi);
  const dependencies = {
    spawnProcess: fake.spawnProcess,
    graceMs: 50,
    // Under a launcher the SDK must never open a session in this process.
    createSession: () => { throw Error('Pi started in this process.'); },
    ...options.dependencies,
  };
  const open = (runtimeOptions = {}) => CompanionRuntime.open(root, config, {
    createMain: openOptions => openPiSession(openOptions, dependencies),
    ...runtimeOptions,
  });
  const connected = async runtimeOptions => {
    const runtime = await open(runtimeOptions);
    // A regression that leaves a prompt waiting must fail its own test, not hang the run.
    t.after(() => Promise.race([runtime.close(), new Promise(resolve => setTimeout(resolve, 2000).unref())]));
    await runtime.connect();
    return runtime;
  };
  return { root, config, fake, dependencies, open, connected };
}

const responses = (fake, id) => fake.received.filter(record => record.type === 'extension_ui_response' && record.id === id);
const answerOf = async (fake, id) => {
  await until(() => responses(fake, id).length, `the reply to ${id}`);
  return responses(fake, id)[0];
};
const bridge = (fake, request) => {
  const id = dialog(fake.children.at(-1), { method: 'input', title: 'companion/bridge', placeholder: JSON.stringify(request) });
  return answerOf(fake, id).then(reply => ({ reply, answer: reply.value === undefined ? undefined : JSON.parse(reply.value) }));
};
const question = { question: 'Which?', choices: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] };

test('the main chat starts as `<launcher> --mode rpc` with its session, binding, extension and prompts', async t => {
  const h = fixture(t);
  const runtime = await h.connected();
  const [{ command, args, options }] = h.fake.spawned;
  assert.equal(command, 'my-pi-launcher');
  assert.deepEqual(args.slice(0, 11), [
    'pi', '--mode', 'rpc', '--session', join(h.root, 'sessions', 'main.jsonl'),
    '--model', 'fixture/local', '--thinking', 'medium', '--extension', extensionPath,
  ]);
  assert.equal(args.filter(value => value === '--append-system-prompt').length, 5);
  assert.ok(args.some(value => value.includes('"background"')), 'the runtime prompt carries the bindings');
  assert.ok(!args.includes('--no-extensions'));
  assert.equal(options.cwd, h.root);
  assert.equal(options.shell, false);
  assert.equal(options.env.EXAMPLE_MODE, '1');
  assert.equal(options.env.PI_OFFLINE, process.env.PI_OFFLINE, 'the launcher keeps its own network default');
  assert.equal(options.env.PI_TELEMETRY, process.env.PI_TELEMETRY);
  const main = (await runtime.state()).main;
  assert.equal(main.sessionFile, join(h.root, 'sessions', 'main.jsonl'));
  assert.equal(runtime.main.sessionId, main.sessionId);
  assert.equal(runtime.main.model.id, 'local');
  assert.deepEqual(h.fake.received.map(record => record.type), ['get_state', 'get_state', 'get_messages', 'get_session_stats']);
  assert.equal(h.fake.received.some(record => record.type === 'prompt'), false);
});

test('a conversation is answered from a live cache that settles to Pi’s own messages and cost', async t => {
  const h = fixture(t);
  const runtime = await h.connected();
  h.fake.gate = Promise.withResolvers();
  await runtime.send('hello', 'message:1');
  await until(() => runtime.messages().at(-1)?.content?.[0]?.text === 'Re', 'streamed text');
  assert.equal(runtime.main.isStreaming, true);
  assert.equal(runtime.mainBusy, true);
  assert.deepEqual(runtime.messages().map(message => message.role), ['user', 'assistant']);
  h.fake.gate.resolve();
  await runtime.idle();
  const run = (await runtime.state()).runs['message:1'];
  assert.equal(run.status, 'completed');
  assert.equal(run.result.text, 'Reply: hello');
  assert.equal(run.cost.usd, 0.5);
  assert.equal(run.cost.sessionId, runtime.main.sessionId);
  assert.equal(runtime.main.isStreaming, false);
  assert.equal(runtime.messages().at(-1).content[0].text, 'Reply: hello');
  assert.equal(runtime.contextInfo().tokens, 10);
  assert.equal(runtime.contextInfo().compacting, false);
});

test('prompt dispositions: handled never waits, queued waits for the run, a rejection is a failed receipt', async t => {
  const h = fixture(t, {
    script: {
      prompt: (reply, reject, command, { run }) => {
        if (command.message === '/command') reply({ disposition: 'handled' });
        else if (command.message === 'refused') reject('Agent is already processing a prompt.');
        else {
          reply({ disposition: command.message === 'later' ? 'queued' : 'started' });
          void run(command.message);
        }
      },
    },
  });
  const runtime = await h.connected();
  await runtime.send('/command', 'message:handled');
  await runtime.idle();
  const handled = (await runtime.state()).runs['message:handled'];
  assert.equal(handled.status, 'completed');
  assert.equal(handled.result.text, '');
  assert.equal(runtime.mainBusy, false);
  assert.equal(runtime.main.isStreaming, false);

  await assert.rejects(runtime.send('refused', 'message:refused'), /rejected before submission/i);
  await runtime.idle();
  const refused = (await runtime.state()).runs['message:refused'];
  assert.equal(refused.status, 'failed');
  assert.equal(refused.result.noModel, true);
  assert.match(refused.result.error, /already processing/);

  await runtime.send('later', 'message:queued');
  await runtime.idle();
  assert.equal((await runtime.state()).runs['message:queued'].result.text, 'Reply: later');
});

test('no conversation opens in this process while a launcher is configured', async t => {
  const h = fixture(t);
  await assert.rejects(openImportedPiSession({ root: h.root, config: h.config, sessionId: 'any' }, h.dependencies), /none may run in this process/);
  assert.equal(h.fake.spawned.length, 0);
});

test('a run that is accepted and settled in one read still completes its prompt', { timeout: 3000 }, async t => {
  const h = fixture(t, {
    script: {
      prompt: (_reply, _reject, command, { child, pi }) => {
        const user = { role: 'user', content: command.message, timestamp: Date.now() };
        const assistant = { role: 'assistant', content: [{ type: 'text', text: 'Instant' }], stopReason: 'stop', timestamp: Date.now() };
        pi.messages.push(user, assistant);
        child.stdout.write([
          { type: 'response', id: command.id, command: 'prompt', success: true, data: { disposition: 'started' } },
          { type: 'agent_start' },
          { type: 'message_end', message: assistant },
          { type: 'agent_settled' },
        ].map(record => `${JSON.stringify(record)}\n`).join(''));
      },
    },
  });
  const runtime = await h.connected();
  await runtime.send('quick', 'message:quick');
  await runtime.idle();
  const run = (await runtime.state()).runs['message:quick'];
  assert.equal(run.status, 'completed');
  assert.equal(run.result.text, 'Instant');
  assert.equal(runtime.main.isStreaming, false);
});

test('a child that exits before accepting a prompt rejects it and stops the chat', async t => {
  const h = fixture(t, { script: { prompt: (_reply, _reject, _command, { child }) => child.exit(1, 'launcher: login required') } });
  const runtime = await h.connected();
  await assert.rejects(runtime.send('hello', 'message:dead'), /login required|did not pass Pi preflight/);
  await runtime.idle();
  assert.equal((await runtime.state()).runs['message:dead'].status, 'failed');
  await until(() => runtime.mainFault, 'the chat fault');
  assert.match(runtime.mainFault.message, /exited before completion \(1\).*login required/);
  assert.equal(runtime.fault, null);
});

test('a second message steers the running turn; clearing and aborting reach Pi', async t => {
  const h = fixture(t);
  const runtime = await h.connected();
  h.fake.gate = Promise.withResolvers();
  await runtime.send('first', 'message:first');
  await until(() => runtime.main.isStreaming, 'the run to start');
  assert.deepEqual(await runtime.send('and this', 'message:second'), { id: 'message:second', queued: true });
  assert.deepEqual(h.fake.received.filter(record => record.type === 'steer').map(record => record.message), ['and this']);
  await runtime.cancel('message:first');
  assert.ok(h.fake.received.some(record => record.type === 'abort'));
  assert.equal((await runtime.state()).runs['message:first'].status, 'interrupted');
  assert.equal(runtime.main.isStreaming, false);
  await runtime.reset();
  assert.equal(h.fake.spawned.length, 2, 'a fresh conversation is a second child');
  assert.notEqual((await runtime.state()).main.sessionFile, join(h.root, 'sessions', 'main.jsonl'));
  assert.ok(h.fake.children[0].stdin.writableEnded, 'the old child was asked to exit');
});

test('Pi-side compaction refreshes the transcript and is reported to observers', async t => {
  const h = fixture(t);
  const runtime = await h.connected();
  await runtime.send('hello', 'message:1');
  await runtime.idle();
  h.fake.messages = [{ role: 'compactionSummary', summary: 'short', timestamp: 1 }];
  const child = h.fake.children[0];
  child.emit_({ type: 'compaction_start', reason: 'threshold' });
  await until(() => runtime.main.isCompacting, 'compaction to start');
  assert.equal(runtime.contextInfo().compacting, true);
  child.emit_({ type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false });
  await until(() => runtime.messages().length === 1, 'the compacted transcript');
  assert.equal(runtime.main.isCompacting, false);
  assert.equal(runtime.contextInfo().last.status, 'completed');
});

test('a binding, identity or missing tool that differs is disposed before any prompt', async t => {
  for (const [pi, expected] of [
    [{ thinking: 'low' }, /binding/],
    [{ model: { provider: 'fixture', id: 'other' } }, /binding/],
    [{ hello: false }, /did not activate/],
    [{ hello: ['ask_question'] }, /run_schedule, companion_memory, model_settings/],
  ]) {
    const h = fixture(t, pi);
    await assert.rejects(openPiSession({ root: h.root, config: h.config }, h.dependencies), expected);
    const [child] = h.fake.children;
    assert.ok(child.stdin.writableEnded, 'the rejected child was asked to exit');
    assert.equal(h.fake.received.some(record => record.type === 'prompt'), false);
    assert.equal(existsSync(join(h.root, 'runtime', 'companion.sqlite')), false);
  }

  const h = fixture(t);
  const session = await openPiSession({ root: h.root, config: h.config }, h.dependencies);
  const header = JSON.parse(readFileSync(session.sessionFile, 'utf8').split('\n')[0]);
  await closePiSession(session);
  const saved = { sessionId: header.id, sessionFile: session.sessionFile };
  await closePiSession(await openPiSession({ root: h.root, config: h.config, saved }, h.dependencies));
  await assert.rejects(openPiSession({ root: h.root, config: h.config, saved: { ...saved, sessionId: 'other' } }, h.dependencies), /identity/);
  assert.equal(h.fake.spawned.length, 2, 'the identity check runs before a child starts');
  writeFileSync(session.sessionFile, `${JSON.stringify({ ...header, cwd: tmpdir() })}\n`);
  await assert.rejects(openPiSession({ root: h.root, config: h.config, saved }, h.dependencies), /different directory/);
  assert.equal(h.fake.spawned.length, 2);
});

test('a child that never answers, cannot start or exits is a clear failure that leaves nothing running', async t => {
  const silent = fixture(t, { script: { get_state: () => {} }, ignoreStdinEnd: true }, { dependencies: { startupTimeoutMs: 30 } });
  await assert.rejects(openPiSession({ root: silent.root, config: silent.config }, silent.dependencies), /did not become ready/);
  assert.ok(silent.fake.children[0].stdin.writableEnded);
  await until(() => silent.fake.children[0].signals.includes('SIGTERM'), 'the stuck child to be signalled');

  const missing = fixture(t, { script: { get_state: () => {} } });
  const spawnProcess = (...args) => {
    const child = missing.fake.spawnProcess(...args);
    setImmediate(() => {
      child.emit('error', Object.assign(Error('spawn my-pi-launcher ENOENT'), { code: 'ENOENT' }));
      child.exit(-2);
    });
    return child;
  };
  await assert.rejects(openPiSession({ root: missing.root, config: missing.config }, { ...missing.dependencies, spawnProcess }), /ENOENT/);

  const refused = fixture(t, { script: { get_state: () => {} } });
  const refusing = (...args) => {
    const child = refused.fake.spawnProcess(...args);
    setImmediate(() => child.exit(1, 'This installation requires its extensions and rejects the given flags.'));
    return child;
  };
  await assert.rejects(openPiSession({ root: refused.root, config: refused.config }, { ...refused.dependencies, spawnProcess: refusing }), /exited before completion \(1\).*rejects the given flags/);
});

test('a child that exits unasked stops the chat but not scheduled work; a requested exit does not', async t => {
  const h = fixture(t);
  const runtime = await h.open();
  await runtime.connect();
  h.fake.gate = Promise.withResolvers();
  await runtime.send('hello', 'message:1');
  await until(() => runtime.main.isStreaming, 'the run to start');
  h.fake.children[0].exit(3, 'my-pi-launcher: credentials expired');
  await runtime.idle();
  const run = (await runtime.state()).runs['message:1'];
  assert.equal(run.status, 'interrupted');
  assert.match(run.result.error, /exited before completion \(3\).*credentials expired/);
  await until(() => runtime.mainFault, 'the chat fault');
  assert.equal(runtime.fault, null);
  await assert.rejects(runtime.send('again'), /Main chat stopped: .*exited before completion \(3\).*Restart Companion/);
  const check = await runtime.dispatch({ id: 'check-after-exit', kind: 'background', title: 'Check' },
    async () => ({ status: 'completed', text: 'Nothing new.', cost: null }));
  assert.equal(check.status, 'completed');
  await runtime.close();

  const calm = fixture(t);
  const second = await calm.open();
  await second.connect();
  await second.close();
  assert.equal(second.fault, null);
  assert.deepEqual(calm.fake.children[0].signals, []);
});

test('closing asks Pi to exit by closing stdin and signals only a child that ignores it', async t => {
  const h = fixture(t, { ignoreStdinEnd: true });
  const session = await openPiSession({ root: h.root, config: h.config }, h.dependencies);
  const closing = closePiSession(session);
  await closing;
  assert.ok(h.fake.children[0].stdin.writableEnded);
  assert.deepEqual(h.fake.children[0].signals, ['SIGTERM']);
  assert.equal(await session.exited, null);
  await closePiSession(session);
});

test('extension dialogs from other extensions reach the user as bounded choices or are declined', async t => {
  const asked = [];
  const h = fixture(t);
  const runtime = await h.connected({
    askQuestion: async (request, signal) => {
      asked.push({ request, aborted: signal.aborted });
      return request.question.startsWith('Allow') ? 'yes' : request.choices.at(-1).value;
    },
  });
  const child = h.fake.children[0];
  const ask = record => answerOf(h.fake, dialog(child, record));

  assert.equal((await ask({ method: 'select', title: 'Pick one', options: ['red', 'green', 'blue'] })).value, 'blue');
  assert.deepEqual(asked[0].request.choices.map(choice => choice.label), ['red', 'green', 'blue']);
  assert.equal((await ask({ method: 'confirm', title: 'Allow command?', message: 'rm -r build' })).confirmed, true);
  assert.equal(asked[1].request.question, 'Allow command? — rm -r build');
  assert.equal((await ask({ method: 'confirm', title: 'Proceed?' })).confirmed, false);

  const before = asked.length;
  for (const record of [
    { method: 'input', title: 'Name', placeholder: 'x' },
    { method: 'editor', title: 'Edit', prefill: 'x' },
    { method: 'select', title: 'Too few', options: ['only'] },
    { method: 'select', title: 'Too many', options: ['1', '2', '3', '4', '5', '6', '7'] },
    { method: 'select', title: '', options: ['a', 'b'] },
    { method: 'select', title: 'No options' },
    { method: 'confirm', title: 'Allow command?', message: `rm -r build ${'x'.repeat(240)}` },
    { method: 'select', title: `Run ${'y'.repeat(240)}?`, options: ['yes', 'no'] },
    { method: 'select', title: 'Pick one', options: ['short', 'z'.repeat(81)] },
  ]) {
    assert.equal((await ask(record)).cancelled, true, JSON.stringify(record).slice(0, 80));
  }
  assert.equal(asked.length, before, 'declined dialogs, including text that would be cut, never reached the user');
  assert.equal((await ask({ method: 'confirm', title: 'Allow command?', message: 'line one\nline two' })).confirmed, true);
  assert.equal(asked.at(-1).request.question, 'Allow command? \u2014 line one line two');

  const before2 = h.fake.received.length;
  for (const method of ['notify', 'setTitle', 'setWidget', 'set_editor_text']) {
    dialog(child, { method, message: 'x', title: 'x', widgetKey: 'k', text: 'x' });
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.fake.received.length, before2, 'fire-and-forget updates need no reply');
  assert.equal(runtime.fault, null);
});

test('without an interface a dialog is declined, and a timeout or abort ends a waiting question', async t => {
  const headless = fixture(t);
  await headless.connected();
  const id = dialog(headless.fake.children[0], { method: 'select', title: 'Pick', options: ['a', 'b'] });
  assert.equal((await answerOf(headless.fake, id)).cancelled, true);

  const h = fixture(t);
  const pending = [];
  const runtime = await h.connected({
    askQuestion: (request, signal) => new Promise(resolve => {
      pending.push(signal);
      signal.addEventListener('abort', () => resolve(null), { once: true });
    }),
  });
  const timed = dialog(h.fake.children[0], { method: 'select', title: 'Quick', options: ['a', 'b'], timeout: 20 });
  assert.equal((await answerOf(h.fake, timed)).cancelled, true);
  assert.equal(pending[0].aborted, true);

  const open = dialog(h.fake.children[0], { method: 'select', title: 'Waiting', options: ['a', 'b'] });
  await until(() => pending.length === 2, 'the question');
  assert.equal(pending[1].aborted, false);
  await runtime.main.abort();
  assert.equal((await answerOf(h.fake, open)).cancelled, true);
  assert.equal(pending[1].aborted, true);
});

test('bridge requests run the real Companion tools in Companion with the child’s own call identity', async t => {
  const asked = [];
  const triggered = [];
  const h = fixture(t);
  const runtime = await h.connected({
    askQuestion: async (request, signal) => {
      asked.push({ request, signal });
      return 'b';
    },
    triggerSchedule: async (scheduleId, callId, signal) => {
      triggered.push({ scheduleId, callId, signal });
      return { status: 'admitted', scheduleId };
    },
  });
  const sessionId = runtime.main.sessionId;

  const answered = await bridge(h.fake, { op: 'tool', name: 'ask_question', id: 'call-1', params: question });
  assert.equal(answered.answer.ok, true);
  assert.deepEqual(answered.answer.result.details, { status: 'answered', answer: { value: 'b', label: 'B' } });
  assert.deepEqual(asked[0].request, question);

  const scheduled = await bridge(h.fake, { op: 'tool', name: 'run_schedule', id: 'call-2', params: { scheduleId: 'daily-check' } });
  assert.deepEqual(scheduled.answer.result.details, { status: 'admitted', scheduleId: 'daily-check' });
  assert.deepEqual(triggered.map(({ scheduleId, callId }) => ({ scheduleId, callId })), [{ scheduleId: 'daily-check', callId: `${sessionId}:call-2` }]);

  const remembered = await bridge(h.fake, { op: 'tool', name: 'companion_memory', id: 'call-3', params: { action: 'add', text: 'Rent is due November 1' } });
  assert.equal(remembered.answer.ok, true);
  assert.equal(readFileSync(join(h.root, 'memory.md'), 'utf8'), '- Rent is due November 1\n');
  assert.deepEqual((await bridge(h.fake, { op: 'memory' })).answer, { ok: true, result: ['Rent is due November 1'] });

  const invalid = await bridge(h.fake, { op: 'tool', name: 'ask_question', id: 'call-4', params: { question: 'Only one', choices: [question.choices[0]] } });
  assert.equal(invalid.answer.ok, false);
  assert.match(invalid.answer.error, /Invalid question/);
});

test('a bridge request cannot reach anything but the registered tools', async t => {
  const h = fixture(t);
  await h.connected();
  for (const request of [
    { op: 'tool', name: 'bash', id: 'x', params: {} },
    { op: 'tool', name: '__proto__', id: 'x', params: {} },
    { op: 'tool', name: 'constructor', id: 'x', params: {} },
    { op: 'tool', name: 'ask_question', params: question },
    { op: 'tool', name: 'ask_question', id: '', params: question },
    { op: 'tool', name: 'ask_question', id: 'x'.repeat(201), params: question },
    { op: 'tool', name: 'ask_question', id: 'x' },
    { op: 'tool', name: 'ask_question', id: 'x', params: 'text' },
    { op: 'settings' },
    [],
    null,
    'text',
  ]) {
    const { answer } = await bridge(h.fake, request);
    assert.equal(answer.ok, false, JSON.stringify(request));
    assert.match(answer.error, /Invalid bridge request/);
  }
  for (const placeholder of ['{not json', undefined, 'x'.repeat(1048577)]) {
    const id = dialog(h.fake.children[0], { method: 'input', title: 'companion/bridge', placeholder });
    const reply = await answerOf(h.fake, id);
    assert.equal(JSON.parse(reply.value).ok, false);
  }
  const other = dialog(h.fake.children[0], { method: 'select', title: 'companion/bridge', options: ['a', 'b'] });
  assert.equal((await answerOf(h.fake, other)).cancelled, true);
  assert.equal(existsSync(join(h.root, 'memory.md')), false);
});

test('model_settings through the bridge persists, changes the live child, and reports what Pi observed', async t => {
  const h = fixture(t, {
    // Pi clamps an effort the model lacks.
    script: { set_thinking_level: (reply, _reject, command, { pi }) => { pi.thinking = command.level === 'xhigh' ? 'high' : command.level; reply(); } },
  });
  const runtime = await h.connected();
  const inspect = await bridge(h.fake, { op: 'tool', name: 'model_settings', id: 'call-1', params: { action: 'inspect', scope: 'main' } });
  assert.deepEqual(inspect.answer.result.details.activeMainBinding, { model: 'fixture/local', effort: 'medium' });
  assert.equal(inspect.answer.result.details.settings.main.model, 'fixture/local');

  const update = await bridge(h.fake, { op: 'tool', name: 'model_settings', id: 'call-2', params: { action: 'update', scope: 'all', model: 'fixture/next', effort: 'high' } });
  const details = update.answer.result.details;
  assert.equal(details.persisted.status, 'complete');
  assert.deepEqual(details.activeRuntime, { status: 'verified', effective: { model: 'fixture/next', effort: 'high' } });
  assert.deepEqual(JSON.parse(readFileSync(join(h.root, 'config.json'), 'utf8')).main, { cwd: h.root, model: 'fixture/next', effort: 'high' });
  assert.equal(h.config.background.model, 'fixture/next');
  assert.equal(JSON.parse(readFileSync(join(h.root, 'config.json'), 'utf8')).launcher.command[0], 'my-pi-launcher');
  assert.deepEqual(h.fake.received.filter(record => ['set_model', 'set_thinking_level'].includes(record.type)).map(record => record.type), ['set_model', 'set_thinking_level']);
  assert.equal(runtime.main.model.id, 'next');
  assert.equal(runtime.main.thinkingLevel, 'high');

  const missing = await bridge(h.fake, { op: 'tool', name: 'model_settings', id: 'call-3', params: { action: 'update', scope: 'main', model: 'fixture/absent' } });
  assert.equal(missing.answer.result.details.persisted.status, 'failed');
  assert.match(missing.answer.result.details.persisted.failed.error, /not installed/);
  assert.equal(runtime.main.model.id, 'next');

  const rejected = await bridge(h.fake, { op: 'tool', name: 'model_settings', id: 'call-4', params: { action: 'update', scope: 'main', effort: 'xhigh' } });
  assert.equal(rejected.answer.result.details.activeRuntime.status, 'unverified');
});

test('a bridge answer is not delivered after the child that asked has gone', async t => {
  const h = fixture(t);
  const released = Promise.withResolvers();
  const signals = [];
  await h.connected({ askQuestion: (_request, signal) => { signals.push(signal); return released.promise; } });
  const child = h.fake.children[0];
  const id = dialog(child, { method: 'input', title: 'companion/bridge', placeholder: JSON.stringify({ op: 'tool', name: 'ask_question', id: 'late', params: question }) });
  await until(() => signals.length === 1, 'the question to wait');
  child.exit(0);
  await until(() => signals[0].aborted, 'the question to be cancelled');
  released.resolve('a');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(responses(h.fake, id).length, 0);
});
