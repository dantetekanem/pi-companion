import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIDGE, serveBridge } from './bridge.mjs';
import { createScheduleTool, createSettingsTool } from './companion-tools.mjs';
import { piCommand, piEnvironment } from './launcher.mjs';
import { createMemoryTool, readMemory } from './memory.mjs';
import { runModelSettings } from './model-settings.mjs';
import { MAX_SESSION_BYTES, readSessionHeader } from './migration/ownership.mjs';
import { createQuestionTool } from './questions.mjs';
import { startRpcProcess } from './rpc-process.mjs';

export const extensionPath = fileURLToPath(new URL('./companion-extension.mjs', import.meta.url));
const dialogMethods = new Set(['select', 'confirm', 'input', 'editor']);
// An approval must show everything it approves, so text that would be cut declines the dialog instead.
const fullLine = (value, limit) => {
  const line = String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').trim();
  return line.length <= limit ? line : null;
};
const unavailable = error => {
  if (!error.commandRejected) throw error;
  return null;
};
const realOrSame = path => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};
// Pi runs a saved conversation in the directory its header records, so a changed cwd must not pass silently.
const sameDirectory = (left, right) => realOrSame(left) === realOrSame(right);

const isMessage = value => Boolean(value) && typeof value === 'object';

// Assistant text only; thinking and tool-call blocks never reach the transcript view.
function applyUpdate(message, update) {
  if (!message || !update) return;
  message.content ??= [];
  const block = message.content[update.contentIndex];
  if (update.type === 'text_start') message.content[update.contentIndex] = { type: 'text', text: '' };
  else if (update.type === 'text_delta' && block?.type === 'text') block.text += update.delta;
  else if (update.type === 'text_end' && block?.type === 'text') block.text = update.content;
}

/**
 * The main conversation as a Pi RPC child behind the configured launcher. It offers the surface of the
 * SDK session that the runtime uses, from a cache that events keep live and get_messages settles.
 */
class PiRpcSession {
  messages = [];
  model = null;
  thinkingLevel = null;
  isStreaming = false;
  isCompacting = false;
  autoCompactionEnabled = true;
  hello = null;

  constructor({ askQuestion, tools, memory, graceMs }) {
    Object.assign(this, { askQuestion, tools, memory, graceMs });
    this.listeners = new Set();
    this.calls = new Set();
    this.waiters = new Set();
    this.idle = new Set();
    this.stats = null;
    this.open = null;
    this.syncing = null;
    this.disposed = false;
    this.exit = Promise.withResolvers();
    this.exited = this.exit.promise;
  }

  attach(child) {
    this.child = child;
    child.closed.then(({ error }) => {
      for (const controller of this.calls) controller.abort();
      for (const waiter of this.waiters) waiter.reject(error);
      this.waiters.clear();
      for (const resolve of this.idle) resolve();
      this.idle.clear();
      this.isStreaming = false;
      this.exit.resolve(this.disposed ? null : error);
    });
  }

  absorb(state) {
    if (this.sessionId !== undefined && state.sessionId !== this.sessionId) {
      throw Error('Main Pi conversation identity changed.');
    }
    this.sessionId = state.sessionId;
    this.sessionFile = state.sessionFile;
    this.model = state.model ?? null;
    this.thinkingLevel = state.thinkingLevel;
    this.isStreaming = Boolean(state.isStreaming);
    this.isCompacting = Boolean(state.isCompacting);
    this.autoCompactionEnabled = state.autoCompactionEnabled ?? true;
  }

  /** One serialized pass so a slow reply can never overwrite a newer one. */
  pull() {
    const run = (this.syncing ?? Promise.resolve()).then(async () => {
      const state = await this.child.request('get_state');
      this.absorb(state);
      if (!state.isStreaming) this.messages = (await this.child.request('get_messages')).messages;
      this.stats = await this.child.request('get_session_stats').catch(unavailable);
    });
    this.syncing = run.catch(() => {});
    return run;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSessionStats() { return this.stats ?? { sessionId: this.sessionId }; }
  getContextUsage() { return this.stats?.contextUsage; }

  accept(record) {
    if (record.type === 'extension_ui_request') {
      void this.dialog(record);
      return;
    }
    if (record.type === 'response') return;
    if (record.type === 'agent_start') this.isStreaming = true;
    else if (record.type === 'agent_settled') void this.settle();
    else if (record.type === 'compaction_start') this.isCompacting = true;
    else if (record.type === 'thinking_level_changed') this.thinkingLevel = record.level;
    else if (record.type === 'message_start' && isMessage(record.message)) {
      this.open = record.message;
      this.messages.push(record.message);
    } else if (record.type === 'message_update') applyUpdate(this.open, record.assistantMessageEvent);
    else if (record.type === 'message_end' && isMessage(record.message)) {
      const index = this.messages.lastIndexOf(this.open);
      if (index === -1) this.messages.push(record.message);
      else this.messages[index] = record.message;
      this.open = null;
    } else if (record.type === 'compaction_end') {
      this.isCompacting = false;
      this.pull().catch(() => {});
    }
    for (const listener of this.listeners) {
      try {
        listener(record);
      } catch {
        // An observer cannot change what the child did.
      }
    }
  }

  async settle() {
    this.isStreaming = false;
    const waiting = [...this.waiters];
    this.waiters.clear();
    let failure;
    try {
      await this.pull();
    } catch (error) {
      if (!error.commandRejected) failure = error;
    }
    for (const resolve of this.idle) resolve();
    this.idle.clear();
    for (const waiter of waiting) {
      if (failure) waiter.reject(failure);
      else waiter.resolve();
    }
  }

  async prompt(text, { preflightResult } = {}) {
    const run = Promise.withResolvers();
    run.promise.catch(() => {});
    let disposition;
    try {
      await this.child.request('prompt', { message: text }, data => {
        disposition = data?.disposition ?? 'started';
        // Records after this response belong to the run, so the wait is armed as the response is read.
        if (disposition !== 'handled') {
          this.waiters.add(run);
          this.isStreaming = true;
        }
      });
    } catch (error) {
      if (error.commandRejected) preflightResult?.(false);
      throw error;
    }
    preflightResult?.(disposition);
    if (disposition !== 'handled') await run.promise;
  }

  async steer(text) {
    return (await this.child.request('steer', { message: text }))?.disposition;
  }

  clearQueue() {
    return this.child.request('clear_queue').catch(() => ({ steering: [], followUp: [] }));
  }

  async abort() {
    for (const controller of this.calls) controller.abort();
    await this.child.request('abort').catch(() => {});
  }

  waitForIdle() {
    return this.isStreaming ? new Promise(resolve => this.idle.add(resolve)) : Promise.resolve();
  }

  dispose() {
    if (!this.disposing) {
      this.disposed = true;
      for (const controller of this.calls) controller.abort();
      this.disposing = this.child.shutdown(this.graceMs).then(() => {});
    }
    return this.disposing;
  }

  async binding() {
    this.absorb(await this.child.request('get_state'));
    return { model: this.model && `${this.model.provider}/${this.model.id}`, effort: this.thinkingLevel };
  }

  async modelCatalog() {
    const { models } = await this.child.request('get_available_models');
    return { getModel: (provider, id) => models.find(model => model.provider === provider && model.id === id) };
  }

  /** Pi's RPC setters change this session only; they do not save Pi defaults. */
  async apply({ model, effort }) {
    try {
      if (model) await this.child.request('set_model', { provider: model.provider, modelId: model.id });
      if (effort !== undefined) await this.child.request('set_thinking_level', { level: effort });
    } catch (error) {
      throw Object.assign(Error(error.message), { effective: await this.binding().catch(() => undefined) });
    }
    return this.binding();
  }

  async dialog({ id, method, title, placeholder, statusKey, statusText, ...request }) {
    if (method === 'setStatus' && statusKey === BRIDGE) {
      try {
        this.hello = JSON.parse(statusText);
      } catch {
        this.hello = null;
      }
    }
    if (!dialogMethods.has(method)) return;
    const controller = new AbortController();
    this.calls.add(controller);
    let reply = { cancelled: true };
    try {
      if (method === 'input' && title === BRIDGE) {
        reply = { value: JSON.stringify(await serveBridge(placeholder, this, controller.signal)) };
      } else {
        reply = await this.route({ method, title, ...request }, controller.signal) ?? reply;
      }
    } catch {
      reply = { cancelled: true };
    } finally {
      this.calls.delete(controller);
    }
    this.child.send({ type: 'extension_ui_response', id, ...reply });
  }

  /** Another extension's dialog reaches the user only as a bounded choice; anything else is declined. */
  async route({ method, title, message, options, timeout }, signal) {
    if (!this.askQuestion || !['select', 'confirm'].includes(method)) return null;
    const choices = method === 'confirm'
      ? [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]
      : Array.isArray(options) ? options.map((option, index) => ({ value: String(index), label: fullLine(option, 80) })) : [];
    const question = fullLine([title, message].filter(Boolean).join(' — '), 240);
    if (!question || choices.length < 2 || choices.length > 6 || choices.some(choice => !choice.label)) return null;
    const limit = timeout > 0 ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : signal;
    const selected = await this.askQuestion({ question, choices }, limit);
    if (selected === undefined || selected === null || limit.aborted) return null;
    if (method === 'confirm') return { confirmed: selected === 'yes' };
    const option = options[Number(selected)];
    return option === undefined ? null : { value: option };
  }
}

function within(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(message)), ms);
    timer.unref();
  })]).finally(() => clearTimeout(timer));
}

/** Starts the main chat as `<launcher> --mode rpc`; nothing is submitted, and a binding that differs is disposed. */
export async function openRpcSession(
  { root, config, file, expected, askQuestion, triggerSchedule, prompts },
  { spawnProcess, startupTimeoutMs = 180000, graceMs } = {},
) {
  if (expected && !sameDirectory(readSessionHeader(file).cwd, config.main.cwd)) {
    throw Error('Main Pi conversation was recorded in a different directory than the configured cwd.');
  }
  const session = new PiRpcSession({
    askQuestion,
    graceMs,
    tools: {},
    memory: () => readMemory(root),
  });
  session.tools = {
    ask_question: createQuestionTool(askQuestion),
    run_schedule: createScheduleTool(triggerSchedule),
    companion_memory: createMemoryTool(root),
    model_settings: createSettingsTool(request => runModelSettings({
      root,
      config,
      request,
      binding: () => session.binding(),
      modelRuntime: () => session.modelCatalog(),
      apply: change => session.apply(change),
    })),
  };
  const { command, args } = piCommand(config.launcher, [
    '--mode', 'rpc',
    '--session', file,
    ...(config.main.model ? ['--model', config.main.model] : []),
    '--thinking', config.main.effort,
    '--extension', extensionPath,
    ...prompts.flatMap(text => ['--append-system-prompt', text]),
  ]);
  session.attach(startRpcProcess({
    command,
    args,
    cwd: config.main.cwd,
    env: piEnvironment(config.launcher),
    spawnProcess,
    // A reply never exceeds the transcript it describes.
    maxRecordBytes: MAX_SESSION_BYTES,
    name: 'Main Pi',
    onRecord: record => session.accept(record),
  }));
  try {
    const state = await within(session.child.request('get_state'), startupTimeoutMs, `Main Pi did not become ready within ${startupTimeoutMs / 1000} seconds.`);
    const model = state.model && `${state.model.provider}/${state.model.id}`;
    if (!state.sessionId || state.sessionFile !== resolve(file) || (expected && state.sessionId !== expected.sessionId)) {
      throw Error('Main Pi conversation identity changed.');
    }
    if (state.thinkingLevel !== config.main.effort || !model || (config.main.model && model !== config.main.model)) {
      throw Error('Pi model or thinking binding changed.');
    }
    const missing = Object.keys(session.tools).filter(name => !session.hello?.tools?.includes(name));
    if (missing.length) throw Error(`The Companion extension did not activate its tools: ${missing.join(', ')}.`);
    session.absorb(state);
    await session.pull();
    return session;
  } catch (error) {
    await session.dispose();
    throw error;
  }
}
