import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { validateBinding } from './schedules.mjs';
import { piCommand, piEnvironment } from './launcher.mjs';
import { clean, startRpcProcess } from './rpc-process.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validCost = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const completionGroup = Symbol('completion group');
const dialogMethods = new Set(['select', 'confirm', 'input', 'editor']);
// A grouped swarm suppresses member reports and answers once, through a wake.
const agentsStarted = ({ toolName, isError, result }) => {
  const details = result?.details;
  if (isError || !details) return [];
  if (toolName === 'spawn_agent') return [details.name];
  if (toolName !== 'spawn_swarm_agents') return [];
  const names = (details.spawned ?? []).map(agent => agent.name);
  return details.completionGroup && names.length ? [completionGroup] : names;
};

export function buildInvocation(request) {
  if (request.harness !== 'pi') throw Error('Execution requires an explicit Pi binding.');
  validateBinding(request);
  if (!uuid.test(request.id) || !isAbsolute(request.cwd ?? '') || typeof request.prompt !== 'string'
    || !request.prompt.trim() || Buffer.byteLength(request.prompt) > 65536) {
    throw Error('Invalid harness request identity, cwd or bounded prompt.');
  }
  if (request.purpose !== undefined && !['migration-repair', 'reflection', 'session-patterns', 'compatibility-check'].includes(request.purpose)) {
    throw Error('Unsupported harness purpose.');
  }
  const noTools = request.purpose !== undefined && request.purpose !== 'compatibility-check';
  const system = readFileSync(new URL(`../prompts/${request.purpose ?? 'background'}.md`, import.meta.url), 'utf8');
  if (!isAbsolute(request.sessionFile ?? '')) throw Error('Pi requires an explicit job session file.');
  const args = [
    '--mode', 'rpc',
    '--session', request.sessionFile,
    '--thinking', request.effort,
    // Tool-enabled jobs keep Pi's normal prompt, tool guidance and extension guidelines.
    ...(noTools ? [
      '--no-tools',
      // Some managed Pi installations load required extensions and refuse --no-extensions.
      ...(request.launcher?.managedExtensions ? [] : ['--no-extensions']),
      '--no-skills', '--no-prompt-templates', '--no-themes',
      '--no-context-files', '--no-approve',
      '--system-prompt', system,
    ] : ['--append-system-prompt', system]),
  ];
  if (request.model) args.push('--model', request.model);
  return piCommand(request.launcher, args);
}

/** The caller persists admission before invoking this function. It never retries a child; only its signal stops one. */
export async function runHarness(request, { spawnProcess = spawn, maxOutputBytes = 1048576, onEvent = () => {} } = {}) {
  const invocation = buildInvocation(request);
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) throw Error('Invalid harness bounds.');
  const result = {
    id: request.id,
    harness: 'pi',
    status: 'failed',
    text: '',
    cost: null,
    model: request.model,
    effort: request.effort,
    sessionId: null,
    freshSession: !existsSync(request.sessionFile),
  };
  if (request.signal?.aborted) return { ...result, status: 'interrupted', error: 'Cancelled before dispatch.' };

  const settled = Promise.withResolvers();
  settled.promise.catch(() => {});
  let child;
  let assistant;
  // Agents live in this child and report as later turns, so a settled lead may not be finished.
  const agents = new Set();
  const accept = record => {
    // Nobody is watching a job, so a dialog from any extension is declined.
    if (record.type === 'extension_ui_request' && dialogMethods.has(record.method)) {
      child.send({ type: 'extension_ui_response', id: record.id, cancelled: true });
    }
    if (record.type === 'message_end' && record.message?.role === 'assistant') {
      assistant = record.message;
      result.text = clean(assistant.content?.filter(part => part.type === 'text').map(part => part.text).join('\n'));
    }
    if (record.type === 'tool_execution_end') {
      for (const agent of agentsStarted(record)) agents.add(agent);
    }
    if (record.type === 'message_end' && record.message?.customType === 'pi-extended-teams-report') {
      agents.delete(record.message.details?.name);
    }
    if (record.type === 'message_end' && record.message?.customType === 'pi-extended-teams-wake') {
      agents.delete(completionGroup);
    }
    if (record.type === 'extension_error') child.fail(Error(clean(record.error || 'Pi extension handler failed.')));
    if (record.type === 'agent_settled') {
      if (record.aborted === true) child.fail(Object.assign(Error('Pi agent run was aborted.'), { interrupted: true }));
      else if (!agents.size) settled.resolve();
    }
    onEvent(record);
  };
  try {
    child = startRpcProcess({
      ...invocation,
      cwd: request.cwd,
      env: piEnvironment(request.launcher),
      spawnProcess,
      maxRecordBytes: maxOutputBytes,
      onRecord: accept,
      onFail: error => settled.reject(error),
    });
  } catch (error) {
    return { ...result, error: clean(error.message) };
  }
  child.closed.then(({ error }) => settled.reject(error));

  const cancel = () => child.fail(Object.assign(Error('Harness cancelled.'), { interrupted: true }));
  request.signal?.addEventListener('abort', cancel, { once: true });
  try {
    const state = await child.request('get_state');
    if (!state?.sessionId || state.thinkingLevel !== request.effort) {
      throw Error('Pi did not retain the requested effort; no prompt was submitted.');
    }
    const model = state.model && `${state.model.provider}/${state.model.id}`;
    if (!model || (request.model?.includes('/') && request.model !== model)) {
      throw Error('Pi did not retain the requested model; no prompt was submitted.');
    }
    result.sessionId = state.sessionId;
    result.model = model;
    const response = await child.request('prompt', { message: request.prompt });
    if (response?.disposition === 'handled') {
      throw Error('Pi handled the prompt without starting an assistant response.');
    }
    await settled.promise;
    result.text = clean(assistant?.content?.filter(part => part.type === 'text').map(part => part.text).join('\n'));
    if (assistant?.stopReason !== 'stop' || !result.text.trim()) {
      throw Error(`Pi did not finish a response (${assistant?.stopReason ?? 'missing'}).`);
    }
    let stats;
    let statsUnavailable = false;
    try {
      stats = await child.request('get_session_stats');
    } catch (error) {
      if (!error.commandRejected || child.failure || child.exited) throw error;
      statsUnavailable = true;
    }
    if (!statsUnavailable && stats?.sessionId !== state.sessionId) {
      throw Error('Pi session identity changed during the job.');
    }
    if (validCost(stats?.cost)) {
      result.cost = { usd: stats.cost, kind: 'estimate', cumulative: true, sessionId: state.sessionId };
    }
    result.status = 'completed';
    child.terminate();
    await child.closed;
  } catch (error) {
    result.status = (child.failure ?? error).interrupted ? 'interrupted' : 'failed';
    result.error = clean((child.failure ?? error).message).slice(0, 2000);
  } finally {
    request.signal?.removeEventListener('abort', cancel);
    child.terminate();
    await child.closed;
  }
  return result;
}
