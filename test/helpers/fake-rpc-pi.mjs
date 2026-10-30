import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

export const companionTools = ['ask_question', 'run_schedule', 'companion_memory', 'model_settings'];
const argument = (args, flag) => args[args.indexOf(flag) + 1];

/**
 * An in-memory Pi RPC child. Commands arrive on stdin and answers and events leave on stdout, as in Pi.
 * It writes the session header Pi would write, so saved identities survive a reconnect.
 * `script` may replace any command: script.prompt(command, { reply, reject, emit, pi }).
 */
export function fakePiRpc({ model = { provider: 'fixture', id: 'local' }, thinking, hello = companionTools, script = {}, models, ignoreStdinEnd = false } = {}) {
  const pi = {
    spawned: [],
    children: [],
    received: [],
    messages: [],
    model,
    thinking,
    streaming: false,
    cost: 0,
    exit: null,
  };
  pi.spawnProcess = (command, args, options) => {
    const spawned = { command, args, options };
    pi.spawned.push(spawned);
    const file = argument(args, '--session');
    let id;
    try {
      id = JSON.parse(readFileSync(file, 'utf8').split('\n')[0]).id;
    } catch {
      id = randomUUID();
      writeFileSync(file, `${JSON.stringify({ type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd: options.cwd })}\n`);
    }
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: undefined,
      signals: [],
    });
    pi.children.push(child);
    let closed = false;
    const emit = record => { if (!closed) child.stdout.write(`${JSON.stringify(record)}\n`); };
    const close = (code = 0, signal = null) => {
      if (closed) return;
      closed = true;
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', code, signal));
    };
    child.kill = signal => {
      child.signals.push(signal);
      close(null, signal);
      return true;
    };
    child.emit_ = emit;
    child.exit = (code = 1, stderr = '') => {
      if (stderr) child.stderr.write(stderr);
      close(code);
    };
    spawned.child = child;
    const state = () => ({
      model: pi.model,
      thinkingLevel: pi.thinking ?? argument(args, '--thinking'),
      isStreaming: pi.streaming,
      isCompacting: false,
      sessionFile: file,
      sessionId: id,
      autoCompactionEnabled: true,
      messageCount: pi.messages.length,
    });
    const run = async text => {
      pi.streaming = true;
      emit({ type: 'agent_start' });
      const user = { role: 'user', content: text, timestamp: Date.now() };
      emit({ type: 'message_start', message: user });
      emit({ type: 'message_end', message: user });
      pi.messages.push(user);
      emit({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: Date.now() } });
      emit({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } });
      emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Re' } });
      await pi.gate?.promise;
      const assistant = {
        role: 'assistant',
        content: [{ type: 'text', text: `Reply: ${text}` }],
        stopReason: pi.stopReason ?? 'stop',
        timestamp: Date.now(),
      };
      emit({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: assistant.content[0].text } });
      emit({ type: 'message_end', message: assistant });
      pi.messages.push(assistant);
      pi.cost += 0.5;
      emit({ type: 'agent_end', messages: [] });
      pi.streaming = false;
      emit({ type: 'agent_settled', aborted: pi.aborted === true });
      pi.aborted = false;
    };
    const commands = {
      get_state: reply => reply(state()),
      get_messages: reply => reply({ messages: pi.messages }),
      get_session_stats: reply => reply({
        sessionFile: file, sessionId: id, cost: pi.cost, contextUsage: { tokens: 10, contextWindow: 1000, percent: 1 },
      }),
      get_available_models: reply => reply({ models: models ?? [pi.model, { provider: 'fixture', id: 'next' }] }),
      set_model: (reply, _reject, command) => {
        pi.model = { provider: command.provider, id: command.modelId };
        reply(pi.model);
      },
      set_thinking_level: (reply, _reject, command) => {
        pi.thinking = command.level;
        reply();
      },
      steer: reply => reply({ disposition: 'queued' }),
      clear_queue: reply => reply({ steering: [], followUp: [] }),
      abort: reply => {
        pi.aborted = true;
        pi.gate?.resolve();
        reply();
      },
      prompt: (reply, _reject, command) => {
        reply({ disposition: 'started' });
        void run(command.message);
      },
    };
    let buffer = '';
    child.stdin.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const record = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        pi.received.push(record);
        if (record.type === 'extension_ui_response') continue;
        const reply = data => emit({ type: 'response', id: record.id, command: record.type, success: true, ...(data === undefined ? {} : { data }) });
        const reject = error => emit({ type: 'response', id: record.id, command: record.type, success: false, error });
        const handler = script[record.type] ?? commands[record.type];
        if (handler) handler(reply, reject, record, { emit, pi, child, run });
        else reject(`Unknown command: ${record.type}`);
      }
    });
    child.stdin.on('end', () => { if (!ignoreStdinEnd) close(0); });
    // Pi's extensions start before it reads input, so the status record precedes every response.
    if (hello) emit({ type: 'extension_ui_request', id: 'hello', method: 'setStatus', statusKey: 'companion/bridge', statusText: JSON.stringify({ version: 1, tools: hello }) });
    return child;
  };
  return pi;
}

/** Ask the host as the Companion extension does, and resolve its decoded answer. */
export function dialog(child, record) {
  const id = `ui-${randomUUID()}`;
  child.emit_({ type: 'extension_ui_request', id, ...record });
  return id;
}
