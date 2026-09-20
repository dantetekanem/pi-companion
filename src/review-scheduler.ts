import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Wake } from './experience.ts';

export type ScheduledTask = {
  id: string; name?: string; title?: string; action: string; type: string; schedule: string; prompt?: string;
  scope: string; sessionFile: string; enabled: boolean; status: string; disabledAt?: string; runOwner?: unknown;
};
export function scheduledTasks(file: string): ScheduledTask[] {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const tasks = data.tasks ?? data;
    if (!Array.isArray(tasks)) throw Error('Invalid scheduler storage.');
    return tasks;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
export function matchDelivery(text: string, task: ScheduledTask): string | undefined {
  if (task.action !== 'prompt' || !task.prompt) return;
  const prefix = `[Scheduled task ${task.id} fired]\nName: ${task.name ?? task.title ?? '(unnamed)'}\nAction: prompt\nType: ${task.type}\nSchedule: ${task.schedule}\nScheduled for: `;
  const suffix = `\n${task.prompt}`;
  if (!text.startsWith(prefix) || !text.endsWith(suffix)) return;
  const at = text.slice(prefix.length, -suffix.length);
  if (at.includes('\n') || !Number.isFinite(Date.parse(at)) || Date.parse(at) > Date.now() + 5000) return;
  return `${task.id}:${at}`;
}
export const reviewWakeText = (wake: Wake) => `companion-daily:${wake.token}`;
export class ReviewScheduler {
  constructor(private pi: ExtensionAPI, private ctx: ExtensionContext, private file: string) {}
  private command(name: string) {
    const commands = this.pi.getCommands().filter(command => command.name.replace(/:\d+$/, '') === name
      && command.sourceInfo?.path.replaceAll('\\', '/').includes('/@jl1990/pi-scheduler/'));
    if (commands.length !== 1) throw Error(`A single installed scheduler ${name} command is required.`);
    return commands[0].name;
  }
  find(wake: Wake): ScheduledTask | undefined {
    const sessionFile = this.ctx.sessionManager.getSessionFile();
    if (!sessionFile) throw Error('Companion requires a saved owning session.');
    const matches = scheduledTasks(this.file).filter(task => task.scope === 'session' && task.sessionFile === sessionFile && task.prompt === reviewWakeText(wake));
    if (matches.length > 1) throw Error('Duplicate Companion daily wakes.');
    const task = matches[0];
    if (!task) {
      if (wake.schedulerId) throw Error('The Companion daily schedule was removed or changed.');
      return;
    }
    if (task.action !== 'prompt' || task.type !== 'interval' || task.schedule !== wake.schedule
      || !/^task_[a-zA-Z0-9_]+$/.test(task.id) || (wake.schedulerId && wake.schedulerId !== task.id)) throw Error('The Companion daily schedule configuration changed.');
    return task;
  }
  async ensure(wake: Wake, beforeCreate: () => void): Promise<string> {
    const task = this.find(wake);
    if (task) {
      if (task.enabled && ['pending', 'running'].includes(task.status)) return task.id;
      if (task.status !== 'pending' || !wake.pausedAt || task.disabledAt !== wake.pausedAt) throw Error('The daily schedule was stopped outside Companion; it will not be revived.');
      this.pi.sendUserMessage(`/${this.command('schedule-enable')} ${task.id}`, { expandPromptTemplates: true, deliverAs: 'followUp' });
    } else {
      if (wake.requested) throw Error('Daily schedule creation is unconfirmed; it will not be duplicated.');
      const command = this.command('schedule');
      beforeCreate();
      this.pi.sendUserMessage(`/${command} prompt interval ${wake.schedule} :: ${reviewWakeText(wake)}`, { expandPromptTemplates: true, deliverAs: 'followUp' });
    }
    const deadline = Date.now() + 2000;
    do {
      const observed = this.find(wake);
      if (observed?.enabled && ['pending', 'running'].includes(observed.status)) return observed.id;
      await delay(25);
    } while (Date.now() < deadline);
    throw Error('Scheduler did not confirm the daily wake.');
  }
  async disable(wake: Wake): Promise<string | undefined> {
    let requested = false;
    const deadline = Date.now() + 2000;
    do {
      const task = this.find(wake);
      if (!task) {
        if (wake.requested) throw Error('Daily schedule creation remains unconfirmed while Companion is stopped.');
        return;
      }
      if (!task.enabled && !task.runOwner && task.status !== 'running') return requested ? task.disabledAt : undefined;
      if (!task.runOwner && task.status !== 'running') {
        requested = true;
        this.pi.sendUserMessage(`/${this.command('schedule-disable')} ${task.id}`, { expandPromptTemplates: true, deliverAs: 'followUp' });
      }
      await delay(25);
    } while (Date.now() < deadline);
    throw Error('Daily schedule stop is pending; Companion is stopped locally.');
  }
}
