import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { ExperienceStore, record, recordEvidence, RecordSchema, type Evidence } from './experience.ts';
import { experienceContext, review } from './reflection.ts';
import { matchDelivery, reviewWakeText, ReviewScheduler, scheduledTasks, type ScheduledTask } from './review-scheduler.ts';

export type ReinforcementPaths = {
  root: string;
  schedulerFile: string;
  schedulesFile: string;
  reportsFile: string;
  reviewSettingsFile: string;
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const prompt = (name: string) => readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), 'utf8');
export function registerReinforcement(pi: ExtensionAPI, paths: ReinforcementPaths) {
  let running: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let controls = Promise.resolve();
  let epoch = 0;
  const storeFor = (ctx: ExtensionContext) => new ExperienceStore(paths.root, ctx.sessionManager.getSessionId());
  const notify = (ctx: ExtensionContext, error: unknown) => {
    if (ctx.hasUI) ctx.ui.notify(`Companion: ${error instanceof Error ? error.message : 'learning failed'}`, 'error');
  };
  const owned = (ctx: ExtensionContext, task: ScheduledTask) => {
    if (task.scope !== 'session' || task.sessionFile !== ctx.sessionManager.getSessionFile()) return false;
    try { return [...readFileSync(paths.schedulesFile, 'utf8').matchAll(/^## (.+)$/gm)].some(match => match[1].trim() === task.name); }
    catch { return false; }
  };
  const capture = (ctx: ExtensionContext, input: Omit<Evidence, 'at' | 'provider'>) => {
    const provider = ctx.model?.provider;
    if (!provider) return;
    storeFor(ctx).update(state => {
      if (state.enabled) recordEvidence(state, { ...input, provider });
    });
  };
  const snapshot = (ctx: ExtensionContext, task: ScheduledTask, receipt?: string) => {
    if (!owned(ctx, task)) return;
    const history = storeFor(ctx).load().evidence;
    const origin = history.find(item => item.taskId === task.id);
    if (origin && origin.provider !== ctx.model?.provider) return;
    const text = JSON.stringify({ name: task.name, action: task.action, type: task.type, schedule: task.schedule,
      enabled: task.enabled, status: task.status, prompt: task.prompt?.slice(0, 1200) });
    capture(ctx, { id: `schedule:${hash(receipt ?? `${task.id}:${text}`)}`, kind: 'schedule', taskId: task.id, text });
  };
  const observe = (ctx: ExtensionContext) => {
    for (const task of scheduledTasks(paths.schedulerFile)) snapshot(ctx, task);
  };
  const settle = async (ctx: ExtensionContext) => {
    const store = storeFor(ctx);
    const state = store.load();
    if (!state.enabled || !state.pendingWake || running || !ctx.isIdle()) return;
    store.update(current => { delete current.pendingWake; });
    const abort = new AbortController();
    controller = abort;
    const timeout = setTimeout(() => abort.abort(new Error('Daily review exceeded two minutes.')), 120000);
    const operation = (async () => {
      try {
        observe(ctx);
        if (await review(store, ctx, paths.reviewSettingsFile, abort.signal)) {
          if (!abort.signal.aborted && store.load().enabled) {
            const context = experienceContext(store.load(), ctx.model?.provider ?? '', 16000);
            pi.sendUserMessage(`${prompt('apply-learning')}\n${JSON.stringify(context)}`, { deliverAs: 'followUp' });
          }
        }
      } catch (error) {
        notify(ctx, error);
      } finally {
        clearTimeout(timeout);
        if (controller === abort) controller = undefined;
      }
    })();
    running = operation;
    try { await operation; } finally { if (running === operation) running = undefined; }
  };
  pi.on('input', async (event, ctx) => {
    try {
      const store = storeFor(ctx), state = store.load();
      if (event.source === 'interactive' || event.source === 'rpc') {
        if (state.enabled && event.text.trim()) capture(ctx, { id: `user:${hash(`${ctx.sessionManager.getLeafId()}:${event.source}:${event.text}`)}`,
          kind: 'user', text: event.text.slice(0, 2000) });
        return;
      }
      if (event.source !== 'extension') return;
      if (state.wake && event.text.endsWith(`\n${reviewWakeText(state.wake)}`)) {
        const task = new ReviewScheduler(pi, ctx, paths.schedulerFile).find(state.wake);
        const delivery = task && matchDelivery(event.text, task);
        if (delivery) {
          if (state.enabled && task.enabled) {
            store.update(current => { current.pendingWake = delivery; });
            await settle(ctx);
          }
          return { action: 'handled' as const };
        }
      }
      if (!state.enabled) return;
      for (const task of scheduledTasks(paths.schedulerFile)) {
        if (!owned(ctx, task)) continue;
        const delivery = matchDelivery(event.text, task);
        if (delivery) {
          const origin = state.evidence.find(item => item.taskId === task.id);
          if (origin && origin.provider !== ctx.model?.provider) return;
          snapshot(ctx, task);
          const runId = `run:${hash(delivery)}`;
          capture(ctx, { id: runId, kind: 'delivery', taskId: task.id, runId, text: `Scheduler delivered ${task.name}; work and usefulness are unverified.` });
          break;
        }
      }
    } catch (error) { notify(ctx, error); }
  });
  pi.on('tool_result', (event, ctx) => {
    if (event.isError || !['schedule_task', 'manage_scheduled_task', 'cancel_scheduled_task'].includes(event.toolName)) return;
    try {
      if (!storeFor(ctx).load().enabled) return;
      const task = (event.details as { task?: ScheduledTask } | undefined)?.task;
      if (task) snapshot(ctx, task, event.toolCallId);
    } catch (error) { notify(ctx, error); }
  });
  pi.on('agent_settled', async (_event, ctx) => {
    try {
      if (storeFor(ctx).load().enabled) {
        observe(ctx);
        await settle(ctx);
      }
    } catch (error) { notify(ctx, error); }
  });
  pi.on('model_select', () => { controller?.abort(new Error('Model changed during daily review.')); });
  pi.on('session_tree', () => { epoch++; controller?.abort(new Error('Session branch changed during daily review.')); });
  pi.registerTool({
    name: 'companion_record', label: 'Companion record',
    description: 'Record Companion observations, run outcomes, questions, natural answers and applied schedule decisions. Questions publish to the existing Markdown feed. Use evidence IDs from Companion context; never invent user feedback. This is an agent tool, not a user workflow.',
    parameters: { ...RecordSchema, type: 'object' },
    async execute(_callId, params, _signal, _onUpdate, ctx) {
      const provider = ctx.model?.provider;
      if (!provider) throw Error('Companion requires a model provider for evidence provenance.');
      const session = hash(ctx.sessionManager.getSessionId());
      storeFor(ctx).update(state => record(state, params, paths.reportsFile, provider, undefined, session));
      return { content: [{ type: 'text', text: `Recorded ${params.id}.` }], details: { id: params.id } };
    },
  });
  return {
    async start(ctx: ExtensionContext) {
      const store = storeFor(ctx);
      store.update(state => {
        if (!state.enabled) state.generation++;
        state.enabled = true;
        state.wake ??= { token: randomUUID(), schedule: '24h' };
      });
      const generation = store.load().generation, activation = epoch;
      const operation = controls.catch(() => {}).then(async () => {
        if (epoch !== activation || !store.load().enabled || store.load().generation !== generation) return;
        const wake = store.load().wake!;
        const id = await new ReviewScheduler(pi, ctx, paths.schedulerFile).ensure(wake, () => store.update(state => { state.wake!.requested = true; }));
        store.update(state => { state.wake!.schedulerId = id; delete state.wake!.pausedAt; });
        if (epoch === activation && store.load().enabled && store.load().generation === generation) observe(ctx);
      });
      controls = operation;
      await operation;
    },
    async stop(ctx: ExtensionContext) {
      const store = storeFor(ctx);
      store.update(state => { state.enabled = false; state.generation++; delete state.pendingWake; });
      controller?.abort(new Error('Companion stopped.'));
      const operation = controls.catch(() => {}).then(async () => {
        const wake = store.load().wake;
        if (!wake) return;
        const pausedAt = await new ReviewScheduler(pi, ctx, paths.schedulerFile).disable(wake);
        if (pausedAt) store.update(state => { state.wake!.pausedAt = pausedAt; });
      });
      controls = operation;
      await operation;
    },
    shutdown() { epoch++; controller?.abort(new Error('Companion session closed or changed.')); },
    context(ctx: ExtensionContext) {
      const state = storeFor(ctx).load();
      if (!state.enabled) return prompt('stopped');
      return `${prompt('learning-context')}\n${JSON.stringify(experienceContext(state, ctx.model?.provider ?? '', 16000))}`;
    },
  };
}
