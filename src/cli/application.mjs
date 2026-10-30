import { watch } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CompanionRuntime } from './runtime.mjs';
import { CompanionRunner } from './runner.mjs';
import { JobActivity } from './job-activity.mjs';
import { CompatibilityDelivery } from './compatibility.mjs';
import { runHarness as defaultRunHarness } from './harnesses.mjs';
import { UsageLedger } from './usage.mjs';
import { atomicJson, loadConfig } from './config.mjs';
import { readLocalView } from './view.mjs';
import { deletedReportIds, readReport, reportText, reportTriage, runOutcomeText } from './reports.mjs';
export { readLocalView } from './view.mjs';

const textOf = message => reportText(typeof message.content === 'string' ? message.content
  : (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n'));
const isVisibleScheduledReport = run => run.kind === 'background'
  && typeof run.scheduleId === 'string' && run.scheduleId.length > 0
  && run.status !== 'running' && (run.status !== 'no_change' || run.trigger === 'manual');
const pauseNote = ({ nextRun, timezone }) => {
  const resumes = new Date(nextRun.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: timezone });
  return ` Paused until ${resumes}; running it manually or editing the schedule resumes it sooner.`;
};
const messageTime = message => {
  const value = message.at ?? message.timestamp;
  const time = typeof value === 'number' ? value : Date.parse(value ?? '');
  return Number.isFinite(time) ? time : null;
};

export class CompanionApplication {
  jobActivity = new Map();
  activeJobIds = new Set();

  observeActivity(id, event) {
    try {
      if (!this.jobActivity.has(id)) {
        this.jobActivity.set(id, new JobActivity());
      }
      this.jobActivity.get(id).accept(event);
      this.requestRefresh();
    } catch {
      /* Preview observers cannot fail a job. */
    }
  }

  static async open(root, { createMain, askQuestion, runHarness, sessionDependencies, shell, now, intervalMs, signal, onChange = null } = {}) {
    signal?.throwIfAborted();
    const app = new CompanionApplication();
    app.onChange = onChange;
    app.config = loadConfig(root);
    // Every job starts its Pi through the configured launcher; without one the request is untouched.
    const { launcher } = app.config;
    if (launcher) {
      const run = runHarness ?? defaultRunHarness;
      runHarness = (request, options) => run({ ...request, launcher }, options);
    }
    app.snapshot = readLocalView(root);
    app.runtime = await CompanionRuntime.open(root, app.config, {
      createMain,
      askQuestion,
      triggerSchedule: (...args) => app.runner.trigger(...args),
      onChange: () => app.requestRefresh(),
    });
    try {
      await app.runtime.connect();
      const initialState = await app.runtime.state();
      app.noticeRunIds = new Set(Object.values(initialState.runs)
        .filter(isVisibleScheduledReport)
        .map(run => run.id));
      app.delivery = new CompatibilityDelivery({
        root: app.runtime.directory,
        runtime: app.runtime,
        config: app.config,
        sessionDependencies,
        runHarness,
        shell,
        now,
      });
      app.ledger = UsageLedger.open(app.runtime.directory, app.config.initializedAt);
      app.runner = new CompanionRunner({
        runtime: app.runtime,
        root: app.runtime.directory,
        config: app.config,
        runHarness,
        now,
        compatibility: app.delivery.adapter,
        onActivity: (id, event) => app.observeActivity(id, event),
      });
      signal?.throwIfAborted();
      app.runner.start({ intervalMs });
      // `pi-companion reports delete` runs in another process and changes no runtime state.
      app.deletionWatcher = watch(join(app.runtime.directory, 'runtime'), (event, name) => {
        if (name?.startsWith('deleted-reports.json')) app.requestRefresh();
      });
      app.deletionWatcher.unref();
      await app.refresh();
      return app;
    } catch (error) {
      await app.close();
      throw error;
    }
  }

  requestRefresh() {
    if (this.closing || !this.runner) return;
    this.refreshDirty = true;
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh().catch(error => {
        this.snapshot = { ...this.snapshot, error: error.message };
        this.onChange?.(this.snapshot);
      });
    }, 25);
    this.refreshTimer.unref();
  }

  refresh() {
    if (!this.refreshing) {
      this.refreshDirty = false;
      this.refreshing = this.project().finally(() => {
        this.refreshing = null;
        if (this.refreshDirty) this.requestRefresh();
      });
    }
    return this.refreshing;
  }

  async project() {
    await this.delivery.syncEvidence();
    const state = await this.runtime.state();
    const loaded = await this.runner.snapshot();
    const runs = Object.values(state.runs).sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
    const deleted = deletedReportIds(this.runtime.directory);
    const reports = runs
      .filter(run => run.kind !== 'main' && run.status !== 'running' && (run.status !== 'no_change' || run.trigger === 'manual'))
      .filter(run => !deleted.has(run.id))
      .map(run => {
        const text = runOutcomeText(run) || 'No result text.';
        const coverage = run.result?.coverage
          ? `\n\nCoverage: ${JSON.stringify(run.result.coverage)}\nOmissions: ${JSON.stringify(run.result.omissions)}`
          : '';
        return {
          id: run.id,
          title: run.title ?? run.scheduleId ?? run.id,
          scheduleId: run.scheduleId,
          at: run.finishedAt,
          body: readReport(this.runtime.directory, run.id, reportText(text + coverage)),
          outcome: run.status,
        };
      });
    const notices = (this.snapshot.messages ?? []).filter(message => message.role === 'notice');
    const noticeIds = new Set(notices.map(message => message.id));
    const noticedRunIds = new Set(this.noticeRunIds);
    const scheduledReports = runs.filter(isVisibleScheduledReport)
      .sort((a, b) => (a.finishedAt ?? '').localeCompare(b.finishedAt ?? ''));
    for (const run of scheduledReports) {
      if (noticedRunIds.has(run.id)) continue;
      noticedRunIds.add(run.id);
      const id = `notice:report:${createHash('sha256').update(String(run.id)).digest('hex')}`;
      if (noticeIds.has(id)) continue;
      const scheduleName = String(run.title ?? run.scheduleId ?? 'your schedule').slice(0, 512);
      const triage = reportTriage(run);
      if (triage?.level === 'nothing') continue;

      const schedule = loaded.schedules.find(item => item.id === run.scheduleId);
      const held = schedule?.nextRun?.state === 'held';
      const message = triage?.message ?? (held ? schedule.nextRun.reason : null);
      notices.push({
        id,
        role: 'notice',
        content: message
          ? `${scheduleName}: ${message}${held ? pauseNote(schedule) : ''}`
          : `Report available for ${scheduleName}`,
        tone: held ? 'blocked' : triage?.level,
        at: run.finishedAt,
      });
      noticeIds.add(id);
    }
    const messages = [
      ...this.runtime.messages()
        .filter(message => ['user', 'assistant', 'custom'].includes(message.role))
        .slice(-100)
        .map(message => ({
          id: createHash('sha256').update(JSON.stringify(message)).digest('hex'),
          role: message.role,
          content: textOf(message).slice(0, 8192),
          at: message.timestamp ?? message.at,
        })),
      ...notices,
    ].map((message, index) => ({ message, index, time: messageTime(message) }))
      .sort((left, right) => {
        if (left.time === null) return right.time === null ? left.index - right.index : -1;
        if (right.time === null) return 1;
        return left.time - right.time || left.index - right.index;
      })
      .map(({ message }) => message)
      .slice(-100);
    const visible = {
      version: 1,
      savedAt: new Date().toISOString(),
      reports: [...reports, ...this.snapshot.history.reports.filter(report => !deleted.has(report.id))].slice(0, 200),
      messages,
      context: this.runtime.contextInfo(),
      runs: [
        ...loaded.errors.map(error => ({ title: `${error.path}: ${error.message}`, state: 'invalid' })),
        ...runs.filter((run, index) => run.status === 'running' || index < 100).map(run => ({
          id: run.id,
          title: run.title ?? run.id,
          state: run.status,
          kind: run.kind,
          scheduleId: run.scheduleId,
          harness: run.harness,
          model: run.model,
          effort: run.effort,
          harnessId: run.harnessId,
          cwd: run.cwd ?? (run.kind === 'main' ? this.config.main.cwd : undefined),
          startedAt: run.startedAt,
        })),
      ],
      lastTick: loaded.lastTick,
      error: this.runtime.mainFault
        ? `Main chat stopped: ${this.runtime.mainFault.message} Restart Companion to reconnect; scheduled checks keep running.`
        : loaded.error,
    };
    const saved = {
      ...visible,
      reports: visible.reports.map(report => ({ ...report, body: report.body.slice(0, 32 * 1024) })),
    };
    const signature = JSON.stringify({ ...saved, savedAt: null, lastTick: null });
    if (signature !== this.savedSignature) {
      atomicJson(join(this.runtime.directory, 'runtime/view.json'), saved);
      this.savedSignature = signature;
    }
    const active = new Set(runs
      .filter(run => run.kind === 'background' && run.scheduleId && run.status === 'running')
      .map(run => run.id));
    const completedJobReports = {};
    for (const id of this.activeJobIds) {
      const run = state.runs[id];
      if (!run || run.status === 'running') continue;
      const body = readReport(this.runtime.directory, id, null);
      if (body !== null) {
        completedJobReports[id] = {
          id,
          title: run.title ?? run.scheduleId ?? id,
          at: run.finishedAt,
          body,
          outcome: run.status,
        };
      }
    }
    for (const id of this.jobActivity.keys()) {
      if (!active.has(id)) this.jobActivity.delete(id);
    }
    this.noticeRunIds = noticedRunIds;
    this.snapshot = {
      ...this.snapshot,
      ...visible,
      jobActivity: Object.fromEntries(
        [...this.jobActivity].map(([id, feed]) => [id, feed.snapshot()]),
      ),
      completedJobReports,
      counts: loaded.counts,
      schedules: loaded.schedules,
      usage: this.ledger.sync(state),
      connection: 'connected',
      busy: this.runtime.mainBusy,
      main: {
        harness: 'pi',
        model: `${this.runtime.main.model.provider}/${this.runtime.main.model.id}`,
        effort: this.runtime.main.thinkingLevel,
      },
    };
    this.onChange?.(this.snapshot);
    this.activeJobIds = this.onChange
      ? active
      : new Set([...this.activeJobIds, ...active]);
    return this.snapshot;
  }

  send(text) { return this.runtime.send(text); }

  kill(runId) { return this.runner.kill(runId); }

  async reset() {
    const result = await this.runtime.reset();
    await this.refreshing?.catch(() => {});
    clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    await this.delivery.syncEvidence();
    this.ledger.sync(await this.runtime.state());
    this.ledger.resetEstimate();
    await this.refresh();
    return result;
  }

  close() {
    if (!this.closing) {
      this.closing = (async () => {
        clearTimeout(this.refreshTimer);
        this.deletionWatcher?.close();
        try {
          await this.runner?.stop();
          await this.delivery?.close();
          await this.runtime.main?.abort();
          await this.runtime.idle();
          await this.refreshing;
          if (this.runner) await this.refresh();
        } finally {
          await this.runtime.close();
        }
      })();
    }
    return this.closing;
  }
}
