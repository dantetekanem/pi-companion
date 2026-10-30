import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { assertRuntimeAdmission, adoptedSession } from './migration/admission.mjs';
import { pinSession } from './migration/ownership.mjs';
import { readSource, sha256 } from './migration/inventory.mjs';
import { efforts, validateBinding } from './schedules.mjs';
import { readSettings, updateSettings } from './settings.mjs';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { createMemoryExtension, createMemoryTool } from './memory.mjs';
import { createQuestionTool } from './questions.mjs';

const settingsScope = Type.Union(['main', 'background', 'schedules', 'all'].map(value => Type.Literal(value)));
const settingsEffort = Type.Union([...new Set(Object.values(efforts).flat())].map(value => Type.Literal(value)));
const settingsParameters = Type.Union([
  Type.Object({ action: Type.Literal('inspect'), scope: settingsScope }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal('update'),
    scope: settingsScope,
    model: Type.Optional(Type.String({ minLength: 3, maxLength: 200 })),
    effort: Type.Optional(settingsEffort),
  }, { additionalProperties: false }),
]);

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
    session.dispose();
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

function createScheduleTool(triggerSchedule) {
  const parameters = Type.Object({
    scheduleId: Type.Optional(Type.String({ minLength: 1, maxLength: 80, pattern: '^[a-z0-9][a-z0-9._-]*$' })),
  }, { additionalProperties: false });
  return defineTool({
    name: 'run_schedule',
    label: 'Run scheduled check once',
    description: 'Only on an explicit user request, run one exact native schedule ID now, even if paused or outside its calendar. No settings change. Omit scheduleId to list up to 20 candidates. Returns admission, not completion; results appear in Reports.',
    parameters,
    async execute(id, request, signal) {
      if (!Check(parameters, request)) throw Error('Invalid schedule request.');
      signal?.throwIfAborted();
      if (!triggerSchedule) throw Error('Schedule triggering is unavailable.');
      const details = await triggerSchedule(request.scheduleId, id, signal);
      return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
    },
  });
}

function currentBinding(session) {
  const model = session.model;
  return {
    model: model ? `${model.provider}/${model.id}` : null,
    effort: session.thinkingLevel,
  };
}

function syncConfig(config, settings) {
  if (!settings || typeof settings !== 'object') return;
  for (const scope of ['main', 'background']) {
    if (settings[scope] && config[scope]) Object.assign(config[scope], settings[scope]);
  }
}

function createModelSettingsTool({ root, config, currentSession, getModelRuntime }) {
  return defineTool({
    name: 'model_settings',
    label: 'Model and effort settings',
    description: 'Inspect or update model and effort for exactly main, background, schedules, or all. Updates require an installed provider/model reference and persist only Companion settings, never Pi global defaults. Main updates also call this session’s non-persistent SDK setters; the receipt separates saved settings from the observed active binding.',
    parameters: settingsParameters,
    async execute(_id, request, signal) {
      if (!Check(settingsParameters, request)) throw Error('Invalid model settings request.');
      signal?.throwIfAborted();
      if (request.action === 'inspect') {
        const details = {
          action: 'inspect',
          scope: request.scope,
          settings: readSettings(root, request.scope),
        };
        if (request.scope === 'main' || request.scope === 'all') {
          details.activeMainBinding = currentSession.current ? currentBinding(currentSession.current) : null;
        }
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
      }

      let result;
      try {
        result = await updateSettings(root, {
          scope: request.scope,
          model: request.model,
          effort: request.effort,
        }, {
          modelRuntime: getModelRuntime(),
          applyCurrent: async ({ model, effort }) => {
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
        });
      } catch (error) {
        result = {
          scope: request.scope,
          persisted: {
            status: 'failed',
            completed: [],
            failed: { target: 'preflight', error: error instanceof Error ? error.message : String(error) },
          },
          activeRuntime: { status: 'unchanged', reason: 'preflight rejected the update before persistence' },
        };
      }
      syncConfig(config, result.persisted?.settings);
      const details = {
        action: 'update',
        requested: {
          ...(request.model === undefined ? {} : { model: request.model }),
          ...(request.effort === undefined ? {} : { effort: request.effort }),
        },
        ...result,
      };
      return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
    },
  });
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
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (fresh && existsSync(file)) throw Error('Fresh main Pi conversation already exists.');
  if (!existsSync(file)) {
    if (expected) throw Error('Saved main Pi conversation is missing; refusing to create a replacement.');
    closeSync(openSync(file, 'wx', 0o600));
  }
  if (!lstatSync(file).isFile()) throw Error('Main Pi conversation must be a regular file.');
  if (expected && (pinSession(file).sessionId !== expected.sessionId || file !== expected.sessionFile)) {
    throw Error('Main Pi conversation identity changed.');
  }
  const manager = SessionManager.open(file, dirname(file), config.main.cwd);
  if (expected && manager.getSessionId() !== expected.sessionId) throw Error('Main Pi conversation identity changed.');
  const effectiveAgentDir = agentDir ?? getAgentDir();
  const settingsManager = SettingsManager.create(config.main.cwd, effectiveAgentDir);
  const appendSystemPrompt = ['prompt', 'taste', 'learning-context', 'v2-runtime', 'memory'].map(name =>
    readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), 'utf8').replace('{{runtime}}', JSON.stringify({
      root,
      notes: join(root, 'notes'),
      schedules: join(root, 'schedules'),
      main: config.main,
      background: config.background,
    }, null, 2)));
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
