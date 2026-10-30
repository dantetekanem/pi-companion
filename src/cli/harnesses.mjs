import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { validateBinding } from './schedules.mjs';

const clean = value => String(value ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validCost = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const completionGroup = Symbol('completion group');
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
      '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes',
      '--no-context-files', '--no-approve',
      '--system-prompt', system,
    ] : ['--append-system-prompt', system]),
  ];
  if (request.model) args.push('--model', request.model);
  return { command: 'pi', args };
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
  let child;
  try {
    child = spawnProcess(invocation.command, invocation.args, {
      cwd: request.cwd,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PI_OFFLINE: '1', PI_TELEMETRY: '0' },
    });
  } catch (error) {
    return { ...result, error: clean(error.message) };
  }

  const pending = new Map();
  const settled = Promise.withResolvers();
  const closed = Promise.withResolvers();
  settled.promise.catch(() => {});
  let serial = 0;
  let buffer = '';
  let recordBytes = 0;
  let stderr = '';
  let failure;
  let exited = false;
  let stopping = false;
  let killTimer;
  let assistant;
  // Agents live in this child and report as later turns, so a settled lead may not be finished.
  const agents = new Set();
  const decoder = new StringDecoder('utf8');
  const terminate = () => {
    if (stopping || exited) return;
    stopping = true;
    const kill = signal => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if (error.code !== 'ESRCH') failure ??= error;
      }
    };
    kill('SIGTERM');
    killTimer = setTimeout(() => kill('SIGKILL'), 500);
    killTimer.unref();
  };
  const fail = error => {
    failure ??= error;
    for (const waiter of pending.values()) waiter.reject(failure);
    pending.clear();
    settled.reject(failure);
    terminate();
  };
  const rpc = (type, data = {}) => {
    const id = `companion-${++serial}`;
    const waiter = Promise.withResolvers();
    if (failure || exited) return Promise.reject(failure ?? Error('Harness exited.'));
    pending.set(id, waiter);
    child.stdin.write(`${JSON.stringify({ id, type, ...data })}\n`, error => {
      if (error) fail(error);
    });
    return waiter.promise;
  };
  const accept = record => {
    if (!record || typeof record !== 'object' || typeof record.type !== 'string') throw Error('Invalid harness event.');
    if (record.type === 'response') {
      const waiter = pending.get(record.id);
      if (waiter) {
        pending.delete(record.id);
        if (record.success) waiter.resolve(record.data);
        else waiter.reject(Object.assign(Error(clean(record.error || 'Harness command failed.')), { commandRejected: true }));
      }
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
    if (record.type === 'extension_error') fail(Error(clean(record.error || 'Pi extension handler failed.')));
    if (record.type === 'agent_settled') {
      if (record.aborted === true) fail(Object.assign(Error('Pi agent run was aborted.'), { interrupted: true }));
      else if (!agents.size) settled.resolve();
    }
    onEvent(record);
  };
  const consume = final => {
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line.trim()) accept(JSON.parse(line));
    }
    if (final && buffer.trim()) {
      accept(JSON.parse(buffer));
      buffer = '';
    }
  };
  // Bound each LF-delimited record, not the whole stream; long healthy runs emit many records.
  const enforceRecordLimit = chunk => {
    let start = 0;
    while (true) {
      const newline = chunk.indexOf('\n', start);
      const segmentEnd = newline === -1 ? chunk.length : newline;
      recordBytes += segmentEnd - start;
      if (recordBytes > maxOutputBytes) throw Error('Harness output record exceeded its byte limit.');
      if (newline === -1) return;
      recordBytes = 0;
      start = newline + 1;
    }
  };
  child.stdout.on('data', chunk => {
    if (failure) return;
    try {
      enforceRecordLimit(chunk);
      buffer += decoder.write(chunk);
      consume(false);
    } catch (error) {
      fail(Error(`Invalid harness output: ${error.message}`));
    }
  });
  child.stdout.on('end', () => {
    if (failure) return;
    try {
      buffer += decoder.end();
      consume(true);
    } catch (error) {
      fail(error);
    }
  });
  child.stderr.on('data', chunk => { stderr = (stderr + clean(chunk)).slice(-2000); });
  child.stdin.on('error', error => { if (!stopping) fail(error); });
  child.on('error', fail);
  child.on('close', (code, signal) => {
    exited = true;
    clearTimeout(killTimer);
    const error = failure ?? Error(`Harness exited before completion (${code ?? signal}). ${stderr}`);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    settled.reject(error);
    closed.resolve({ code, signal });
  });
  const cancel = () => fail(Object.assign(Error('Harness cancelled.'), { interrupted: true }));
  request.signal?.addEventListener('abort', cancel, { once: true });
  try {
    const state = await rpc('get_state');
    if (!state?.sessionId || state.thinkingLevel !== request.effort) {
      throw Error('Pi did not retain the requested effort; no prompt was submitted.');
    }
    const model = state.model && `${state.model.provider}/${state.model.id}`;
    if (!model || (request.model?.includes('/') && request.model !== model)) {
      throw Error('Pi did not retain the requested model; no prompt was submitted.');
    }
    result.sessionId = state.sessionId;
    result.model = model;
    const response = await rpc('prompt', { message: request.prompt });
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
      stats = await rpc('get_session_stats');
    } catch (error) {
      if (!error.commandRejected || failure || exited) throw error;
      statsUnavailable = true;
    }
    if (!statsUnavailable && stats?.sessionId !== state.sessionId) {
      throw Error('Pi session identity changed during the job.');
    }
    if (validCost(stats?.cost)) {
      result.cost = { usd: stats.cost, kind: 'estimate', cumulative: true, sessionId: state.sessionId };
    }
    result.status = 'completed';
    terminate();
    await closed.promise;
  } catch (error) {
    result.status = (failure ?? error).interrupted ? 'interrupted' : 'failed';
    result.error = clean((failure ?? error).message).slice(0, 2000);
  } finally {
    request.signal?.removeEventListener('abort', cancel);
    terminate();
    await closed.promise;
  }
  return result;
}
