import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Store } from './store.ts';

type Task = Record<string, unknown> & { id: string; name: string; schedule: string; disabledAt: string; scope: string; sessionFile: string; type: string; status: string; enabled: boolean };
const configuration = ['name', 'action', 'type', 'schedule', 'scope', 'sessionFile', 'cwd', 'prompt', 'message', 'command', 'maxRuns', 'timeoutMs', 'wakeOn', 'followUpPrompt', 'successPrompt', 'failurePrompt'];
const signature = (task: Task) => createHash('sha256').update(JSON.stringify(configuration.map(key => task[key]))).digest('hex');
const firing = (task: Task) => task.status === 'running' || Boolean(task.runOwner);
export type SchedulerPaths = { schedulerFile: string; schedulesFile: string; isActive?: () => boolean };
export async function controlSchedules(action: 'start' | 'stop' | 'finish-stop', pi: ExtensionAPI, ctx: ExtensionContext, store: Store, paths: SchedulerPaths): Promise<string> {
  const stopping = action !== 'start', verb = stopping ? 'disable' : 'enable';
  const commands = pi.getCommands().filter(c => c.name.replace(/:\d+$/, '') === `schedule-${verb}`
    && c.sourceInfo?.path.replaceAll('\\', '/').includes('/@jl1990/pi-scheduler/'));
  if (commands.length !== 1) throw new Error('A single @jl1990/pi-scheduler command is required.');
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error('Schedule control requires a saved owning session.');
  const names = () => new Set([...readFileSync(paths.schedulesFile, 'utf8').matchAll(/^## (.+)$/gm)].map(match => match[1].trim()));
  const load = (): Task[] => {
    const data = JSON.parse(readFileSync(paths.schedulerFile, 'utf8'));
    const tasks = data.tasks ?? data;
    if (!Array.isArray(tasks)) throw new Error('Invalid scheduler state.');
    return tasks;
  };
  const approved = (task: Task) => task.scope === 'session' && task.sessionFile === sessionFile
    && ['cron', 'interval'].includes(task.type) && names().has(task.name) && /^task_[a-zA-Z0-9_]+$/.test(task.id);
  const active = () => {
    if (paths.isActive && !paths.isActive()) throw new Error('Companion session changed; unfinished stop requests remain saved.');
  };
  const state = store.load();
  if (action === 'stop') {
    const tasks = load().filter(t => approved(t) && t.enabled && ['pending', 'running'].includes(t.status));
    for (const task of tasks) {
      state.stopping = state.stopping.filter(p => p.id !== task.id);
      state.stopping.push({ id: task.id, signature: signature(task) });
    }
    store.save(state);
    if (tasks.some(firing) && ctx.hasUI) ctx.ui.notify('Companion stop requested; waiting for running deliveries to finish. History is preserved.', 'info');
  }
  const candidates = [...(stopping ? state.stopping : state.paused)];
  let changed = 0, skipped = 0;
  nextTask: while (candidates.length) {
    active();
    const candidate = candidates.shift()!;
    const current = load().find(t => t.id === candidate.id);
    const unchanged = current && approved(current) && signature(current) === candidate.signature;
    if (stopping && unchanged && firing(current)) {
      candidates.push(candidate); await delay(100); continue;
    }
    const resumable = current && !current.enabled && current.disabledAt === ('disabledAt' in candidate ? candidate.disabledAt : undefined);
    if (!unchanged || current.status !== 'pending' || firing(current) || (stopping ? !current.enabled : !resumable)) {
      const latest = store.load();
      if (stopping) latest.stopping = latest.stopping.filter(p => p.id !== candidate.id);
      else latest.paused = latest.paused.filter(p => p.id !== candidate.id);
      store.save(latest);
      skipped++; continue;
    }
    // Scheduler commands own scheduling. These waits only confirm or defer a requested pause.
    pi.sendUserMessage(`/${commands[0].name} ${current.id}`, { expandPromptTemplates: true, deliverAs: 'followUp' });
    const deadline = Date.now() + 2000;
    let confirmed: Task | undefined;
    do {
      active();
      const observed = load().find(t => t.id === current.id);
      if (observed && approved(observed) && signature(observed) === signature(current)) {
        if (!firing(observed) && observed.status === 'pending' && observed.enabled === !stopping
          && (!stopping || (observed.disabledAt && observed.disabledAt !== current.disabledAt))) confirmed = observed;
        // A delivery can begin between our read and the scheduler's disable. Its completion re-enables the task.
        if (!confirmed && stopping && (firing(observed) || observed.runCount !== current.runCount)) {
          candidates.push(candidate); await delay(100); continue nextTask;
        }
      }
      if (!confirmed) await delay(25);
    } while (!confirmed && Date.now() < deadline);
    if (!confirmed) throw new Error(`Scheduler did not confirm ${verb} for ${current.id}; check /schedules all before retrying.`);
    const latest = store.load();
    latest.paused = latest.paused.filter(p => p.id !== current.id);
    latest.stopping = latest.stopping.filter(p => p.id !== current.id);
    if (stopping) latest.paused.push({ id: confirmed.id, signature: signature(confirmed), disabledAt: confirmed.disabledAt });
    store.save(latest);
    changed++;
  }
  return `${stopping ? 'Stopped' : 'Resumed'} ${changed} Companion schedule(s) in this session.${skipped ? ` Skipped ${skipped} changed or no-longer-approved task(s).` : ''} History preserved; already-delivered checks are not aborted.`;
}
