import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.ts';
import type { DurableCompanion, CompanionControls } from './durable.ts';
import { ExperienceStore } from './experience.ts';
import { registerReinforcement, type ReinforcementPaths } from './reinforcement.ts';
import { scheduledTasks } from './review-scheduler.ts';
import { controlSchedules, countSchedules, type SchedulerPaths } from './scheduler.ts';
import { companionTailNotice, saveCompanionLocation } from './tail.ts';

const instructions = () => [
  readFileSync(new URL('./prompts/prompt.md', import.meta.url), 'utf8'),
  readFileSync(new URL('./prompts/taste.md', import.meta.url), 'utf8'),
].join('\n\n');

type Paths = SchedulerPaths & ReinforcementPaths & { locationRoot?: string };
export function registerCompanion(pi: ExtensionAPI, paths: Paths): void {
  const reinforcement = registerReinforcement(pi, paths);
  let generation = 0, tailPending = true;
  let control: Promise<void> | undefined;
  const sessionId = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
  const storeFor = (ctx: ExtensionContext) => new Store(paths.root, sessionId(ctx));
  const durableDirectory = join(paths.root, 'durable');
  const hasCheckpoint = () => existsSync(join(durableDirectory, 'companion.sqlite'));
  let runtime: Promise<DurableCompanion> | undefined;
  let closing = Promise.resolve();
  const openRuntime = async (ctx: ExtensionContext) => {
    const token = generation;
    await closing;
    if (generation !== token) throw Error('Companion session changed before opening its checkpoint.');
    if (!runtime) {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) throw Error('Companion requires a saved Pi session.');
      const configured = storeFor(ctx).load().started === true || (countSchedules(ctx, paths) ?? 0) > 0;
      if (!hasCheckpoint() && !configured && existsSync(paths.schedulesFile)) {
        throw Error('Run /companion start in your existing Companion session once to adopt it. Saved routines will not be rebuilt here.');
      }
      runtime = import('./durable.ts').then(({ DurableCompanion }) =>
        DurableCompanion.open(durableDirectory, { sessionId: sessionId(ctx), sessionFile }, configured));
      runtime.catch(() => { runtime = undefined; });
    }
    const opened = await runtime;
    if (generation !== token) throw Error('Companion session changed while opening its checkpoint.');
    return opened;
  };
  const closeRuntime = async () => {
    const current = runtime;
    runtime = undefined;
    closing = closing.then(async () => {
      const opened = await current?.catch(() => undefined);
      await opened?.close();
    });
    await closing;
  };
  const ownsRuntime = async (opened: DurableCompanion, ctx: ExtensionContext) => {
    const owner = (await opened.state()).owner;
    return owner?.sessionId === sessionId(ctx) && owner.sessionFile === ctx.sessionManager.getSessionFile();
  };
  const isCompanionSchedule = (name: unknown) => {
    if (typeof name !== 'string') return false;
    try {
      const headings = new Set([...readFileSync(paths.schedulesFile, 'utf8').matchAll(/^## (.+)$/gm)].map(match => match[1].trim()));
      return headings.has(name.trim());
    } catch { return false; }
  };
  const runControl = async (action: 'start' | 'stop' | 'finish-stop', ctx: ExtensionContext, signal?: AbortSignal) => {
    const token = generation;
    if (control) {
      if (action !== 'finish-stop') throw new Error('Companion schedule control is already running.');
      await control.catch(() => {});
      if (generation !== token) return;
    }
    const operation = controlSchedules(action, pi, ctx, storeFor(ctx), { ...paths, isActive: () => generation === token && !signal?.aborted })
      .then(message => {
        if (generation === token && ctx.hasUI) ctx.ui.notify(message, 'info');
      });
    const tracked: Promise<void> = operation.finally(() => { if (control === tracked) control = undefined; });
    control = tracked;
    await tracked;
  };
  const controlsFor = (ctx: ExtensionContext, token: number): CompanionControls => {
    const active = (signal: AbortSignal) => {
      signal.throwIfAborted();
      if (generation !== token) throw Error('Companion session changed during control.');
    };
    return {
      daily: async (action, signal) => {
        active(signal);
        if (action === 'start') {
          const store = storeFor(ctx), state = store.load();
          state.started = true;
          store.save(state);
          await reinforcement.start(ctx);
        } else await reinforcement.stop(ctx);
      },
      routines: async (action, signal) => {
        active(signal);
        if (storeFor(ctx).load().stopping.length) await runControl('finish-stop', ctx, signal);
        if (action === 'stop' || storeFor(ctx).load().paused.length) await runControl(action, ctx, signal);
      },
    };
  };
  pi.on('before_agent_start', (_event, ctx) => {
    const tail = tailPending ? companionTailNotice(paths) : undefined;
    tailPending = false;
    const state = storeFor(ctx).load();
    const content = [tail, state.experience ? reinforcement.context(ctx) : undefined].filter(Boolean).join('\n\n');
    if (content) return { message: { customType: 'companion-tail', content, display: false } };
  });
  pi.on('session_start', async (_event, ctx) => {
    const token = ++generation;
    reinforcement.shutdown();
    tailPending = true;
    try {
      const state = storeFor(ctx).load();
      if (state.started && !state.experience) {
        new ExperienceStore(paths.root, sessionId(ctx)).update(memory => {
          memory.enabled = !state.paused.length && !state.stopping.length && (countSchedules(ctx, paths) ?? 0) > 0;
        });
      }
      if (hasCheckpoint() && state.started) {
        const opened = await openRuntime(ctx);
        if (!await ownsRuntime(opened, ctx)) {
          await closeRuntime();
          return;
        }
        await opened.recover(controlsFor(ctx, token));
      }
      if (storeFor(ctx).load().stopping.length) void runControl('finish-stop', ctx).catch(error => {
        if (generation === token && ctx.hasUI) ctx.ui.notify(`Companion stop remains pending: ${error.message}`, 'error');
      });
      const memory = storeFor(ctx).load().experience;
      if (memory?.enabled) await reinforcement.start(ctx);
      else if (memory?.wake) await reinforcement.stop(ctx);
    } catch (error) { if (ctx.hasUI) ctx.ui.notify(`Companion recovery: ${error instanceof Error ? error.message : 'failed'}`, 'error'); }
  });
  pi.on('session_shutdown', async () => {
    generation++;
    reinforcement.shutdown();
    await closeRuntime();
  });
  pi.on('tool_call', (event, ctx) => {
    if (event.toolName === 'manage_scheduled_task' && storeFor(ctx).load().experience?.enabled === false) {
      const input = event.input as { id?: unknown; action?: unknown };
      if (['enable', 'update'].includes(String(input.action)) && typeof input.id === 'string'
        && scheduledTasks(paths.schedulerFile).some(task => task.id.startsWith(input.id as string) && task.scope === 'session'
          && task.sessionFile === ctx.sessionManager.getSessionFile() && isCompanionSchedule(task.name))) {
        return { block: true, reason: 'Companion is stopped.' };
      }
    }
    if (event.toolName !== 'schedule_task') return;
    const input = event.input as { name?: unknown; scope?: unknown };
    if (!isCompanionSchedule(input.name)) return;
    if (input.scope !== undefined && input.scope !== 'session') return { block: true, reason: 'Companion schedules must use session scope.' };
    if (storeFor(ctx).load().experience?.enabled === false) return { block: true, reason: 'Companion is stopped.' };
  });
  pi.registerCommand('companion', {
    description: 'Start or stop Companion (session-owned schedules and daily learning).',
    getArgumentCompletions: prefix => {
      const items = ['start', 'stop'].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim(), token = generation;
      const active = () => generation === token;
      try {
        if (action === '' || action === 'start') {
          const opened = await openRuntime(ctx);
          if (!await ownsRuntime(opened, ctx)) {
            const owner = (await opened.state()).owner;
            await closeRuntime();
            if (!owner) throw Error('Companion has no saved owning session.');
            if (typeof ctx.switchSession !== 'function') throw Error(`Resume the saved Companion session: ${owner.sessionFile}`);
            await ctx.switchSession(owner.sessionFile, { withSession: async fresh => {
              await fresh.sendUserMessage('/companion start', { expandPromptTemplates: true, deliverAs: 'followUp' });
            } });
            return;
          }
          if (!active()) return;
          await opened.control('start', controlsFor(ctx, token));
          const stillStarted = () => active() && storeFor(ctx).load().experience?.enabled === true;
          if (stillStarted()) await saveCompanionLocation(pi, paths, stillStarted);
          if (!stillStarted()) return;
          if (await opened.claimSetup()) pi.sendUserMessage(instructions(), { deliverAs: 'followUp' });
          else if (ctx.hasUI) {
            const pendingSetup = (await opened.state()).setup === 'requested';
            ctx.ui.notify(pendingSetup
              ? 'Companion resumed. Initial setup was already reserved and will not be resent; continue in this conversation if it was interrupted.'
              : 'Companion resumed from its saved checkpoint; no setup turn was submitted.', 'info');
          }
          return;
        }
        if (action === 'stop') {
          if (!hasCheckpoint()) {
            const results = await Promise.allSettled([reinforcement.stop(ctx), runControl('stop', ctx)]);
            const failure = results.find(result => result.status === 'rejected');
            if (failure?.status === 'rejected') throw failure.reason;
          } else {
            const opened = await openRuntime(ctx);
            if (!await ownsRuntime(opened, ctx)) {
              await closeRuntime();
              throw Error('Stop Companion in its saved owning session.');
            }
            if (!active()) return;
            await opened.control('stop', controlsFor(ctx, token));
          }
          return;
        }
        throw new Error('Usage: /companion [start|stop]');
      } catch (error) {
        if (active() && ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : 'Companion failed.', 'error');
      }
    },
  });
}
export default function companion(pi: ExtensionAPI): void {
  registerCompanion(pi, { root: join(getAgentDir(), 'companion'),
    schedulerFile: join(homedir(), '.pi', 'agent', 'state', 'scheduler', 'tasks.json'),
    schedulesFile: join(homedir(), '.companion-schedules.md'),
    reportsFile: join(homedir(), '.companion-reports-updates.md'),
    reviewSettingsFile: join(homedir(), '.pi', 'agent', 'pi-extended-teams', 'settings.json') });
}
