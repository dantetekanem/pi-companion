import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { assertRuntimeAdmission, adoptedSession } from './migration/admission.mjs';
import { readSessionHeader } from './migration/ownership.mjs';
import { readSource, sha256 } from './migration/inventory.mjs';
import { validateBinding } from './schedules.mjs';
import { createMemoryExtension, createMemoryTool } from './memory.mjs';
import { createQuestionTool } from './questions.mjs';
import { createScheduleTool, createSettingsTool } from './companion-tools.mjs';
import { runModelSettings } from './model-settings.mjs';
import { openRpcSession } from './rpc-session.mjs';

/** Caller holds the conversation reservation until the SDK and its compaction/retries settle. */
export async function withPiCancellation(session, signal, operation) {
  const agent = session.agent;
  const stream = agent?.streamFunction;
  if (agent) {
    agent.streamFunction = (model, context, options) => {
      signal.throwIfAborted();
      return stream(model, context, {
        ...options,
        signal: AbortSignal.any([signal, ...(options?.signal ? [options.signal] : [])]),
      });
    };
  }
  const abort = () => {
    void session.abort().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    const result = await operation();
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener('abort', abort);
    if (agent) agent.streamFunction = stream;
  }
}

export async function closePiSession(session) {
  if (!session) return;
  try {
    await session.extensionRunner?.emit({ type: 'session_shutdown', reason: 'exit' });
  } finally {
    await session.dispose();
  }
}

/** Pi owns the transcript format. Durable stores only its identity and dispatch receipts. */
export async function openPiSession(
  { root, config, saved, fresh = false, askQuestion, triggerSchedule },
  dependencies = {},
) {
  root = assertRuntimeAdmission(root);
  const adopted = adoptedSession(root);
  const file = mainSessionFile(root, saved, adopted, fresh);
  const expected = fresh ? null : saved ?? adopted;
  if (config.launcher) {
    // Every Pi process runs behind the launcher, so its managed extensions and credentials apply.
    validateBinding({ harness: 'pi', ...config.main });
    claimSessionFile(file, { fresh, expected });
    return openRpcSession({
      root,
      config,
      file,
      expected,
      askQuestion,
      triggerSchedule,
      prompts: mainPrompts(root, config),
    }, dependencies);
  }
  return openConversation({
    root,
    config,
    expected,
    file,
    fresh,
    customTools: [createQuestionTool(askQuestion), createScheduleTool(triggerSchedule), createMemoryTool(root)],
    modelSettings: { root, config },
  }, dependencies);
}

function refuseInProcess(config) {
  if (config.launcher) throw Error('A configured launcher starts every Pi process; none may run in this process.');
}

function claimSessionFile(file, { fresh, expected }) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (fresh && existsSync(file)) throw Error('Fresh main Pi conversation already exists.');
  if (!existsSync(file)) {
    if (expected) throw Error('Saved main Pi conversation is missing; refusing to create a replacement.');
    closeSync(openSync(file, 'wx', 0o600));
  }
  if (!lstatSync(file).isFile()) throw Error('Main Pi conversation must be a regular file.');
  if (expected && (readSessionHeader(file).sessionId !== expected.sessionId || file !== expected.sessionFile)) {
    throw Error('Main Pi conversation identity changed.');
  }
}

function mainPrompts(root, config) {
  return ['prompt', 'taste', 'learning-context', 'v2-runtime', 'memory'].map(name =>
    readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), 'utf8').replace('{{runtime}}', JSON.stringify({
      root,
      notes: join(root, 'notes'),
      schedules: join(root, 'schedules'),
      main: config.main,
      background: config.background,
    }, null, 2)));
}

function mainSessionFile(root, saved, adopted, fresh) {
  const directory = join(root, 'sessions');
  if (fresh) return join(directory, `main-${randomUUID()}.jsonl`);
  if (!saved) return adopted?.sessionFile ?? join(directory, 'main.jsonl');

  const file = saved.sessionFile;
  const isAdopted = saved.sessionId === adopted?.sessionId;
  const original = adopted?.sessionFile ?? join(directory, 'main.jsonl');
  if (typeof file !== 'string' || resolve(dirname(file)) !== resolve(directory)) {
    throw Error('Saved main Pi conversation is outside its owned sessions directory.');
  }
  if (adopted && ((isAdopted && file !== original) || (!isAdopted && file === original))) {
    throw Error('Main Pi conversation identity differs from its adoption.');
  }
  const isGeneratedSessionFile = /^main-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\.jsonl$/i
    .test(basename(file));
  if (file !== original && !isGeneratedSessionFile) {
    throw Error('Saved main Pi conversation identity is not owned.');
  }
  return file;
}

function currentBinding(session) {
  const model = session.model;
  return {
    model: model ? `${model.provider}/${model.id}` : null,
    effort: session.thinkingLevel,
  };
}

function createModelSettingsTool({ root, config, currentSession, getModelRuntime }) {
  return createSettingsTool(request => runModelSettings({
    root,
    config,
    request,
    binding: () => currentSession.current ? currentBinding(currentSession.current) : null,
    modelRuntime: getModelRuntime,
    apply: async ({ model, effort }) => {
      const session = currentSession.current;
      if (!session) throw Error('The active Pi session is unavailable.');
      try {
        if (model) await session.setModel(model, { persist: false });
        if (effort !== undefined) session.setThinkingLevel(effort, { persist: false });
      } catch (error) {
        const failure = new Error(error instanceof Error ? error.message : String(error));
        failure.effective = currentBinding(session);
        throw failure;
      }
      return currentBinding(session);
    },
  }));
}

function importedSession(root, sessionId) {
  root = assertRuntimeAdmission(root);
  const index = JSON.parse(readFileSync(join(root, 'imported/sessions/index.json'), 'utf8'));
  const entry = index.sessions.find(session => session.sessionId === sessionId);
  if (!entry) throw Error('Session is not part of this verified adoption.');
  const bytes = readSource({ ...entry, path: join(root, entry.path) });
  return { root, entry, bytes };
}

export async function importedBinding(root, sessionId, explicit) {
  const { bytes } = importedSession(root, sessionId);
  return bindingFromSession(bytes, explicit);
}

export async function bindingFromSession(bytes, explicit) {
  const { buildSessionContext } = await import('@earendil-works/pi-coding-agent');
  const entries = bytes.toString('utf8').split('\n').filter(Boolean).slice(1).map(line => JSON.parse(line));
  const context = buildSessionContext(entries);
  const binding = explicit ?? {
    model: context.model ? `${context.model.provider}/${context.model.modelId}` : null,
    effort: context.thinkingLevel,
  };
  validateBinding({ harness: 'pi', ...binding });
  if (typeof binding.model !== 'string' || !/^[^/\s]+\/\S+$/.test(binding.model)) {
    throw Error('Adopted session needs an explicit fully qualified delivery binding.');
  }
  if (context.model && binding.model.split('/')[0] !== context.model.provider) {
    throw Error('Adopted conversation cannot be disclosed to a different provider.');
  }
  return { model: binding.model, effort: binding.effort };
}

export async function openImportedPiSession({ root, config, sessionId, binding, saved = false }, dependencies = {}) {
  refuseInProcess(config);
  const source = importedSession(root, sessionId);
  root = source.root;
  if (adoptedSession(root)?.sessionId === sessionId) throw Error('Reuse the already owned main conversation.');
  const selected = await importedBinding(root, sessionId, binding);
  const file = join(root, 'sessions', `legacy-${sha256(sessionId)}.jsonl`);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (!lstatSync(dirname(file)).isDirectory()) throw Error('Owned sessions directory must be real.');
  if (!existsSync(file)) {
    if (saved) throw Error('Saved adopted conversation is missing; refusing to replace it from history.');
    writeFileSync(file, source.bytes, { flag: 'wx', mode: 0o600 });
  }
  return openConversation({
    root,
    config: { ...config, main: { ...selected, cwd: source.entry.cwd } },
    file,
    expected: { sessionId, sessionFile: file },
  }, dependencies);
}

async function openConversation(
  { root, config, expected, file, fresh = false, customTools = [], modelSettings },
  { createSession, agentDir, modelRuntime: suppliedModelRuntime } = {},
) {
  refuseInProcess(config);
  validateBinding({ harness: 'pi', ...config.main });
  const {
    SessionManager,
    createAgentSession,
    createCodemodeExtension,
    createMcpExtension,
    createToolSearchExtension,
    DefaultResourceLoader,
    ModelRuntime,
    resolveCliModel,
    SettingsManager,
    getAgentDir,
  } = await import('@earendil-works/pi-coding-agent');
  claimSessionFile(file, { fresh, expected });
  const manager = SessionManager.open(file, dirname(file), config.main.cwd);
  if (expected && manager.getSessionId() !== expected.sessionId) throw Error('Main Pi conversation identity changed.');
  const effectiveAgentDir = agentDir ?? getAgentDir();
  const settingsManager = SettingsManager.create(config.main.cwd, effectiveAgentDir);
  const appendSystemPrompt = mainPrompts(root, config);
  const resourceLoader = new DefaultResourceLoader({
    cwd: config.main.cwd,
    agentDir: effectiveAgentDir,
    settingsManager,
    extensionFactories: [
      { name: 'codemode', factory: createCodemodeExtension(), builtin: true, replaceable: true },
      { name: 'tool-search', factory: createToolSearchExtension(), builtin: true, replaceable: true },
      { name: 'mcp', factory: createMcpExtension(), builtin: true, replaceable: true },
      createMemoryExtension(root),
    ],
    appendSystemPrompt,
  });
  await resourceLoader.reload();
  let options = {
    cwd: config.main.cwd,
    sessionManager: manager,
    customTools,
    thinkingLevel: config.main.effort,
    settingsManager,
    resourceLoader,
  };
  let modelRuntime = suppliedModelRuntime;
  if (!createSession && !modelRuntime) modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
  let model;
  if (modelRuntime && config.main.model) {
    const resolved = resolveCliModel({ cliModel: config.main.model, modelRuntime });
    if (resolved.error || !resolved.model || resolved.warning) {
      throw Error(resolved.error ?? resolved.warning ?? 'Main model is unavailable.');
    }
    model = resolved.model;
  }
  if (modelRuntime) options = { ...options, modelRuntime, model };
  const currentSession = { current: null };
  if (modelSettings) {
    const settingsTool = createModelSettingsTool({
      ...modelSettings,
      currentSession,
      getModelRuntime: () => currentSession.current?.modelRuntime ?? modelRuntime,
    });
    options = { ...options, customTools: [...customTools, settingsTool] };
  }
  const { session, modelFallbackMessage } = await (createSession ?? createAgentSession)(options);
  currentSession.current = session;
  if (modelFallbackMessage || session.thinkingLevel !== config.main.effort
    || (config.main.model && `${session.model?.provider}/${session.model?.id}` !== config.main.model)) {
    session.dispose();
    throw Error(modelFallbackMessage ?? 'Pi model or thinking binding changed.');
  }
  try {
    await session.bindExtensions({});
    return session;
  } catch (error) {
    await closePiSession(session);
    throw error;
  }
}
