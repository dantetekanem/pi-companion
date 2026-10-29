import { createRequire } from 'node:module';
import { verifyEnginePins } from './legacy-engine.mjs';

// The child receives only one record. TZ is process-local; no global timezone mutation in the UI.
async function run() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 1048576) throw Error('Input bound exceeded.');
    chunks.push(chunk);
  }
  const { binding, operation, task, now, notBefore, result, ok, startedAt, attemptId } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  verifyEnginePins(binding);
  const core = createRequire(binding.core)(binding.core);
  if (operation === 'validate') {
    core.validateTaskSchedule(task.type, task.schedule, new Date(task.createdAt));
    if (task.type === 'interval') {
      const interval = core.parseDurationMs(task.schedule);
      if (task.intervalMs !== undefined && task.intervalMs !== interval) throw Error('Interval changed.');
      if (task.backoff) core.normalizeBackoff(task.backoff, interval, new Date(task.createdAt));
    }
    return true;
  }
  if (operation === 'prepare') {
    const boundary = Date.parse(notBefore);
    const next = Date.parse(task.nextRun ?? task.dueAt);
    if (!Number.isFinite(boundary) || !Number.isFinite(Date.parse(now))) throw Error('Invalid runtime boundary.');
    if (task.enabled && task.status === 'pending' && next <= boundary) {
      if (task.type === 'once') {
        task.enabled = false;
        task.status = 'expired';
        delete task.nextRun;
        task.migrationDisposition = 'Past one-time occurrence preserved, not replayed at cutover.';
      } else if (task.type === 'interval') {
        const interval = task.backoff?.currentIntervalMs ?? core.parseDurationMs(task.schedule);
        if (!Number.isSafeInteger(interval) || interval <= 0) throw Error('Invalid interval.');
        task.nextRun = new Date(next + (Math.floor((boundary - next) / interval) + 1) * interval).toISOString();
        task.dueAt = task.nextRun;
      } else {
        const validated = core.validateTaskSchedule(task.type, task.schedule, new Date(boundary));
        task.nextRun = validated.nextRun;
        task.dueAt = validated.dueAt;
      }
    }
    core.expireOverdueTasks([task], now);
    return { task, dueAt: core.dueTasks([task], now).length ? task.nextRun ?? task.dueAt : null };
  }
  if (operation === 'shell-wake') {
    const wake = core.shouldWakeForShellResult(task, result);
    const prompt = wake ? core.selectShellFollowUpPrompt(task, result) : undefined;
    task.lastResultFingerprint = core.shellResultFingerprint(result);
    task.wakeOnChangeKey = `${task.command ?? ''}\0${task.cwd ?? result.cwd ?? ''}`;
    return { task, wake, prompt: prompt ?? null };
  }
  if (operation === 'complete') {
    core.markScheduledTaskRunning([task], task.id, startedAt, { runOwner: { attemptId } });
    return core.markScheduledTaskCompleted([task], task.id, now, result, { ok });
  }
  throw Error('Unsupported operation.');
}
try {
  process.stdout.write(JSON.stringify({ ok: true, value: await run() }));
} catch {
  process.stdout.write(JSON.stringify({ ok: false }));
}
