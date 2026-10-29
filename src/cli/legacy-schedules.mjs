import { sha256 } from './migration/inventory.mjs';

export function parseCompatibility(source, path) {
  if (Buffer.byteLength(source) > 1048576) throw Error('Compatibility schedule exceeds its byte bound.');
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw Error('Malformed compatibility schedule JSON.');
  }
  if (value.version !== 1
    || !/^legacy-[a-z0-9._-]{1,64}$/.test(value.id ?? '')
    || !value.session?.sessionId
    || !value.session?.sessionFile
    || !value.control
    || !value.legacy
    || value.source?.sha256 !== sha256(JSON.stringify(value.legacy))
    || !value.compatibility
    || !['routine', 'daily-wake'].includes(value.role)) {
    throw Error('Compatibility identity, source or control state is invalid.');
  }
  const task = value.legacy;
  return {
    id: value.id,
    title: task.name ?? task.title ?? task.id,
    cadence: 'compatibility',
    path,
    enabled: task.enabled && value.control.started !== false && (value.role !== 'daily-wake' || value.control.experienceEnabled !== false),
    harness: 'pi',
    model: null,
    effort: null,
    cwd: task.cwd ?? value.session.cwd,
    legacy: value,
  };
}

export class LegacySchedules {
  constructor({ engine, handlers, now = () => new Date() }) {
    Object.assign(this, { engine, handlers, now });
  }

  async prepare(schedule, state, now, { notBefore }) {
    const wrapper = schedule.legacy;
    if (!schedule.enabled) return null;
    const runs = Object.values(state.runs).filter(run => run.scheduleId === schedule.id);
    if (runs.some(run => run.status === 'interrupted' || (run.status !== 'running' && !run.result?.compatibilityTask))) throw Error('A legacy attempt is interrupted or uncertain; explicit reconciliation is required.');
    const last = runs.filter(run => run.result?.compatibilityTask).sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))[0];
    const task = last?.result.compatibilityTask ?? wrapper.legacy;
    const prepared = await this.engine.request(wrapper.compatibility, 'prepare', { task, now: now.toISOString(), notBefore });
    if (!prepared.dueAt) return null;
    return { task: prepared.task, occurrence: { id: `${schedule.id}:${prepared.dueAt}`, scheduledAt: prepared.dueAt } };
  }

  async execute(wrapper, prepared, signal, reservation, { onEvent } = {}) {
    let task = structuredClone(prepared.task);
    const startedAt = this.now().toISOString();
    const input = {
      session: wrapper.session,
      origin: wrapper.origin,
      task,
      scheduledAt: prepared.occurrence.scheduledAt,
      signal,
      reservation,
      onEvent,
    };
    const call = async (kind, extra) => {
      if (signal.aborted) throw Error('Legacy dispatch cancelled.');
      if (typeof this.handlers[kind] !== 'function') throw Error(`No authorized legacy ${kind} handler is connected.`);
      return this.handlers[kind]({ ...input, ...extra });
    };
    let response;
    let result;
    let ok;
    if (wrapper.role === 'daily-wake') {
      response = await call('dailyReview', { wrapper });
      result = {};
      ok = response.status === 'completed' || response.status === 'no_change';
    } else if (task.action === 'shell') {
      result = await call('shell', { command: task.command, cwd: task.cwd ?? wrapper.session.cwd, timeoutMs: task.timeoutMs });
      ok = result.code === 0 && !result.killed;
      const wake = await this.engine.request(wrapper.compatibility, 'shell-wake', { task, result }, signal);
      task = wake.task;
      response = wake.wake ? await call('prompt', { text: wake.prompt, shellResult: result })
        : { status: ok ? 'completed' : 'failed', text: result.stdout ?? '', cost: null, noModel: true };
    } else if (task.action === 'prompt') {
      response = await call('prompt', { text: task.prompt });
      result = {};
      ok = response.status === 'completed' || response.status === 'no_change';
    } else if (task.action === 'notify' || task.action === 'message') {
      response = await call(task.action, { text: task.message, triggerTurn: task.triggerTurn !== false });
      result = {};
      ok = response.status === 'completed' || response.status === 'no_change';
    } else throw Error('Unsupported legacy action.');
    if (signal.aborted || ['interrupted', 'incomplete'].includes(response.status)) return { ...response, status: 'interrupted' };
    const compatibilityTask = await this.engine.request(wrapper.compatibility, 'complete', {
      task,
      now: this.now().toISOString(),
      startedAt,
      attemptId: prepared.occurrence.id,
      result,
      ok,
    }, signal);
    return { ...response, status: ok ? response.status : 'failed', compatibilityTask };
  }
}
