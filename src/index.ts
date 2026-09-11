import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { footer } from './result.ts';
import { Store } from './store.ts';
import { controlSchedules, countSchedules, type SchedulerPaths } from './scheduler.ts';

type Paths = SchedulerPaths & { root: string };
export function registerCompanion(pi: ExtensionAPI, paths: Paths): void {
  let generation = 0;
  let control: Promise<void> | undefined;
  const sessionId = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
  const storeFor = (ctx: ExtensionContext) => new Store(paths.root, sessionId(ctx));
  const refresh = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    try { ctx.ui.setStatus('companion', footer(storeFor(ctx).load(), countSchedules(ctx, paths))); }
    catch { ctx.ui.setStatus('companion', undefined); }
  };
  const isCompanionSchedule = (name: unknown) => {
    if (typeof name !== 'string') return false;
    try {
      const headings = new Set([...readFileSync(paths.schedulesFile, 'utf8').matchAll(/^## (.+)$/gm)].map(match => match[1].trim()));
      return headings.has(name.trim());
    } catch { return false; }
  };
  const runControl = async (action: 'start' | 'stop' | 'finish-stop', ctx: ExtensionContext) => {
    const token = generation;
    if (control) {
      if (action !== 'finish-stop') throw new Error('Companion schedule control is already running.');
      await control.catch(() => {});
      if (generation !== token) return;
    }
    const operation = controlSchedules(action, pi, ctx, storeFor(ctx), { ...paths, isActive: () => generation === token })
      .then(message => {
        if (generation === token && ctx.hasUI) { refresh(ctx); ctx.ui.notify(message, 'info'); }
      });
    const tracked: Promise<void> = operation.finally(() => { if (control === tracked) control = undefined; });
    control = tracked;
    await tracked;
  };
  pi.on('session_start', (_event, ctx) => {
    const token = ++generation;
    try {
      refresh(ctx);
      if (storeFor(ctx).load().stopping.length) void runControl('finish-stop', ctx).catch(error => {
        if (generation === token && ctx.hasUI) ctx.ui.notify(`Companion stop remains pending: ${error.message}`, 'error');
      });
    } catch { if (ctx.hasUI) ctx.ui.setStatus('companion', undefined); }
  });
  pi.on('agent_end', (_event, ctx) => {
    try { refresh(ctx); }
    catch { if (ctx.hasUI) ctx.ui.setStatus('companion', undefined); }
  });
  pi.on('session_shutdown', (_event, ctx) => { generation++; if (ctx.hasUI) ctx.ui.setStatus('companion', undefined); });
  pi.on('tool_call', (event, ctx) => {
    if (event.toolName !== 'schedule_task') return;
    const input = event.input as { name?: unknown; scope?: unknown };
    if (!isCompanionSchedule(input.name)) return;
    if (input.scope !== undefined && input.scope !== 'session') return { block: true, reason: 'Companion schedules must use session scope.' };
  });
  pi.registerCommand('companion', {
    description: 'Start or stop Companion (session-owned schedules).',
    getArgumentCompletions: prefix => {
      const items = ['start', 'stop'].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim(), token = generation;
      const active = () => generation === token;
      try {
        if (action === '' || action === 'start') {
          const store = storeFor(ctx), state = store.load();
          state.started = true;
          store.save(state);
          refresh(ctx);
          try {
            if (storeFor(ctx).load().paused.length) await runControl('start', ctx);
          } finally {
            if (active()) pi.sendUserMessage(readFileSync(new URL('./prompt.md', import.meta.url), 'utf8'), { deliverAs: 'followUp' });
          }
          return;
        }
        if (action === 'stop') {
          await runControl('stop', ctx);
          refresh(ctx);
          return;
        }
        throw new Error('Usage: /companion [start|stop]');
      } catch (error) {
        if (active()) refresh(ctx);
        if (active() && ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : 'Companion failed.', 'error');
      }
    },
  });
}
export default function companion(pi: ExtensionAPI): void {
  registerCompanion(pi, { root: join(getAgentDir(), 'companion'),
    schedulerFile: join(homedir(), '.pi', 'agent', 'state', 'scheduler', 'tasks.json'),
    schedulesFile: join(homedir(), '.companion-schedules.md') });
}
