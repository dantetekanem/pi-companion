import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { SessionDelivery } from './delivery.mjs';
import { DailyReflection } from './reflection.mjs';
import { LegacySchedules } from './legacy-schedules.mjs';
import { SchedulerCompatibility } from './legacy-engine.mjs';
import { executeShell } from './shell.mjs';
import { loadImportedHistory } from './history.mjs';
import { reportText } from './reports.mjs';

const evidenceId = id => `v2-${createHash('sha256').update(id).digest('hex')}`;
const emptyMemory = () => ({
  version: 1,
  enabled: true,
  generation: 0,
  evidence: [],
  questions: [],
  lessons: [],
  decisions: [],
  assessments: [],
  reviews: [],
});
const providerOf = (harness, model) => harness === 'claude' ? 'anthropic' : model?.split('/')[0];

function shellPrompt({ task, text, shellResult }) {
  if (!shellResult) return text;
  return JSON.stringify({
    taskId: task.id,
    command: task.command,
    followUp: text,
    result: {
      code: shellResult.code,
      killed: shellResult.killed,
      cwd: shellResult.cwd,
      stdout: String(shellResult.stdout ?? '').slice(0, 16000),
      stderr: String(shellResult.stderr ?? '').slice(0, 16000),
    },
  });
}

/** Local delivery only. No notification is sent to another application or person. */
export class CompatibilityDelivery {
  constructor({ root, runtime, config, runHarness, shell = executeShell, now }) {
    Object.assign(this, { root, runtime, config });
    this.history = loadImportedHistory(root);
    this.delivery = new SessionDelivery({ root, runtime, config, runHarness });
    this.reflection = new DailyReflection({ root, runtime, config, runHarness, now });
    this.adapter = new LegacySchedules({
      now,
      engine: {
        request: (binding, ...args) => new SchedulerCompatibility({
          version: binding.version,
          core: binding.core,
          pins: binding.pins,
        }).request(binding, ...args),
      },
      handlers: {
        ready: id => this.delivery.ready(id),
        reserve: wrapper => wrapper.role === 'routine' && ['prompt', 'message', 'shell'].includes(wrapper.legacy.action)
          ? this.delivery.reserve(wrapper.session.sessionId)
          : { release() {} },
        prompt: input => this.delivery.prompt({ ...input, text: shellPrompt(input) }),
        message: input => this.delivery.message(input),
        notify: async input => ({ status: 'completed', text: reportText(input.text), noModel: true, cost: null }),
        shell: input => shell(input),
        dailyReview: async input => {
          await this.syncEvidence();
          return this.reflection.review(input);
        },
      },
    });
  }

  syncEvidence() {
    if (!this.syncing) this.syncing = this.collectEvidence().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  async collectEvidence() {
    const snapshot = await this.runtime.state();
    const runs = Object.values(snapshot.runs).filter(run => run.status !== 'running' && !snapshot.evidenceReceipts?.[run.id]);
    if (!runs.length) return;
    const originals = new Map(this.history.origins.map(origin => [
      origin.origin,
      JSON.parse(readFileSync(origin.path, 'utf8')).legacy.experience,
    ]));
    await this.runtime.change(state => {
      state.reflections ??= {};
      state.evidenceReceipts ??= {};
      for (const run of runs) {
        if (state.evidenceReceipts[run.id]) continue;
        if (run.operation === 'compact') {
          state.evidenceReceipts[run.id] = true;
          continue;
        }
        const sessionId = run.legacy ? run.sessionId : state.main?.sessionId;
        const origin = this.history.sessions.find(session => session.sessionId === sessionId)?.origin ?? `main:${sessionId}`;
        state.reflections[origin] ??= originals.get(origin) ?? emptyMemory();
        const memory = state.reflections[origin];
        const model = run.result?.model ?? run.model ?? (run.kind === 'main'
          ? this.config.main.model
          : this.config.legacySessions?.[sessionId]?.model);
        const provider = providerOf(run.harness, model);
        if (provider && memory.enabled) {
          const user = run.kind === 'main';
          const value = {
            id: evidenceId(run.id),
            at: run.finishedAt ?? run.startedAt,
            kind: user ? 'user' : 'outcome',
            provider,
            text: reportText(user
              ? run.prompt
              : `${run.status}: ${run.result?.text || run.result?.error || run.error || 'No result text.'}`).slice(0, 2000),
            ...(user ? {} : { taskId: run.scheduleId ?? run.id, runId: run.id, outcome: run.status }),
          };
          if (!memory.evidence.some(item => item.id === value.id)) memory.evidence.push(value);
        }
        state.evidenceReceipts[run.id] = true;
      }
    });
  }

  async close() {
    await this.delivery.close();
    await this.syncing;
  }
}
