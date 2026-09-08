import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { footer, label, ResultSchema } from './result.ts';
import { Store } from './store.ts';
import { Reader } from './reader.ts';
import { controlSchedules, type SchedulerPaths } from './scheduler.ts';

type Paths = SchedulerPaths & { root: string };
export function registerCompanion(pi: ExtensionAPI, paths: Paths): void {
  let generation = 0;
  let control: Promise<void> | undefined;
  let viewing = false;
  const storeFor = (ctx: ExtensionContext) => new Store(paths.root, ctx.sessionManager.getSessionId());
  const refresh = (ctx: ExtensionContext) => { if (ctx.hasUI) ctx.ui.setStatus('companion', footer(storeFor(ctx).load())); };
  const runControl = async (action: 'start' | 'stop' | 'finish-stop', ctx: ExtensionContext) => {
    const token = generation;
    if (control) {
      if (action !== 'finish-stop') throw new Error('Companion schedule control is already running.');
      await control.catch(() => {});
      if (generation !== token) return;
    }
    const operation = controlSchedules(action, pi, ctx, storeFor(ctx), { ...paths, isActive: () => generation === token })
      .then(message => { if (generation === token && ctx.hasUI) ctx.ui.notify(message, 'info'); });
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
    } catch { if (ctx.hasUI) ctx.ui.setStatus('companion', 'Companion · storage unreadable'); }
  });
  pi.on('session_shutdown', (_event, ctx) => { generation++; if (ctx.hasUI) ctx.ui.setStatus('companion', undefined); });
  pi.registerTool({
    name: 'companion_save', label: 'Save Companion result',
    description: 'Save a finalized update or compiled report in this session. Use a stable ID per result/run. Only actionable findings, material changes or decision blockers are updates. Routine no-change goes in reports. Include every expected source/task in checks, including failed, incomplete and not_run checks; never infer collection from scheduler delivery. Incomplete results may expose blockers, not successful collection. Max body 32000 chars, 40 checks. Does not collect, schedule or mark read.',
    parameters: ResultSchema,
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const added = storeFor(ctx).ingest(params);
      refresh(ctx);
      return { content: [{ type: 'text', text: added ? 'Companion result saved, unread.' : 'Result already saved; read state preserved.' }], details: { id: params.id, saved: true } };
    },
  });
  pi.registerCommand('companion', {
    description: 'Open Companion, or updates | reports | start | stop (session-owned schedules).',
    getArgumentCompletions: prefix => ['updates', 'reports', 'start', 'stop'].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      const action = args.trim(), token = generation;
      const active = () => generation === token;
      try {
        if (action === 'start' || action === 'stop') {
          await runControl(action, ctx);
          return;
        }
        if (!['', 'updates', 'reports'].includes(action)) throw new Error('Usage: /companion [updates|reports|start|stop]');
        if (ctx.mode !== 'tui') throw new Error('Companion views require Pi interactive mode.');
        if (viewing) throw new Error('A Companion view is already open.');
        viewing = true;
        try {
          while (active()) {
            const store = storeFor(ctx);
            const items = store.load().items.filter(item => (item.kind === 'report' || !item.readAt)
              && (action === '' || item.kind === (action === 'reports' ? 'report' : 'update'))).reverse();
            if (!items.length) { ctx.ui.notify('No saved results in this view.', 'info'); return; }
            const choices = items.map((item, i) => `${i + 1}. ${item.readAt ? '[read]' : '[unread]'} ${label(item)} · ${item.savedAt}`);
            const choice = await ctx.ui.select('Companion — opening does not mark read', choices);
            if (!active() || !choice) return;
            const item = items[choices.indexOf(choice)];
            if (!item) return;
            const read = await ctx.ui.custom<boolean>((tui, theme, _keys, done) => {
              const reader = new Reader(item, theme, () => Math.max(4, tui.terminal.rows - 6), done);
              return { render: width => reader.render(width), invalidate: () => reader.invalidate(),
                handleInput: data => { reader.handleInput(data); tui.requestRender(); } };
            });
            if (!active()) return;
            if (read === true) { store.markRead(item.id); refresh(ctx); }
          }
        } finally { viewing = false; }
      } catch (error) {
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
