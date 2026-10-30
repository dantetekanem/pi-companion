import { appendFileSync, lstatSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicJson } from './config.mjs';
import { reportTriage, writePrivate } from './reports.mjs';

const MAX_LOG_BYTES = 1048576;
const MIN_READ_MS = 3000;
const RECENT_REPORTS = 10;
const MIN_REPORTS = 5;
const MIN_TRACKED_DAYS = 7;
const MAX_IGNORED_READ_SHARE = 0.2;
const DAY_MS = 86400000;

const logPath = root => join(root, 'runtime', 'telemetry.jsonl');
const attentionPath = root => join(root, 'runtime', 'report-attention.json');

function parseEvents(file) {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) return [];
  return readFileSync(file, 'utf8').split('\n').flatMap(entry => {
    try {
      const event = JSON.parse(entry);
      return event?.type ? [event] : [];
    } catch {
      return [];
    }
  });
}

function writeEvent(file, event) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

const isStart = event => event.type === 'tracking_started';
const isRealRead = event => event.type === 'report_discussed'
  || (event.type === 'report_read' && event.dwellMs >= MIN_READ_MS);

// A report from before tracking began was never watched, so it says nothing about being ignored.
const isTrackedReport = (run, since) => run.kind === 'background'
  && run.scheduleId
  && run.status === 'completed'
  && Date.parse(run.finishedAt) >= since;

function scheduleAttention(scheduleId, reports, readTimes, trackedLongEnough) {
  const recent = reports
    .toSorted((a, b) => a.finishedAt.localeCompare(b.finishedAt))
    .slice(-RECENT_REPORTS);
  const triage = recent.map(run => reportTriage(run)?.level);
  const reads = recent.flatMap(run => readTimes.get(run.id) ?? []).sort();

  const enoughEvidence = trackedLongEnough && recent.length >= MIN_REPORTS;
  const rarelyRead = reads.length / recent.length <= MAX_IGNORED_READ_SHARE;
  const stillWanted = triage.includes('critical') || recent.some(run => run.trigger === 'manual');

  return {
    scheduleId,
    title: recent.at(-1).title ?? scheduleId,
    reports: recent.length,
    read: reads.length,
    critical: triage.filter(level => level === 'critical').length,
    nothingNew: triage.filter(level => level === 'nothing').length,
    usd: recent.reduce((sum, run) => sum + (run.cost?.usd ?? 0), 0),
    lastReadAt: reads.at(-1) ?? null,
    ignored: enoughEvidence && rarelyRead && !stillWanted,
  };
}

/** Local-only record of how reports get used. It holds run IDs and timings, never report text. */
export class Telemetry {
  constructor(root) {
    this.file = logPath(root);
    this.attentionFile = attentionPath(root);
    this.events = parseEvents(this.file);
  }

  static open(root, now = Date.now()) {
    const telemetry = new Telemetry(root);
    if (!telemetry.events.some(isStart)) {
      telemetry.record({ type: 'tracking_started', at: new Date(now).toISOString() });
    }
    return telemetry;
  }

  // Telemetry observes the product, so a write problem can never reach the dashboard.
  record(event) {
    this.events.push(event);
    try {
      writeEvent(this.file, event);
      if (statSync(this.file).size > MAX_LOG_BYTES) this.keepNewestEvents();
    } catch {
      /* The event still counts for this process. */
    }
  }

  keepNewestEvents() {
    const start = this.events.find(isStart);
    const rest = this.events.filter(event => event !== start);
    this.events = [start, ...rest.slice(Math.floor(rest.length / 2))];
    writePrivate(this.file, this.events.map(event => `${JSON.stringify(event)}\n`).join(''));
  }

  recordReportRead({ id, dwellMs }, now = Date.now()) {
    this.record({ type: 'report_read', at: new Date(now).toISOString(), id, dwellMs });
  }

  recordReportDiscussed(id, now = Date.now()) {
    this.record({ type: 'report_discussed', at: new Date(now).toISOString(), id });
  }

  /** Per-check rollup of its latest reports. `ignored` is a prompt to revisit a check, never a reason to change it. */
  attention(runs, now = Date.now()) {
    const since = Date.parse(this.events.find(isStart).at);
    const trackedLongEnough = now - since >= MIN_TRACKED_DAYS * DAY_MS;
    const readTimes = new Map(this.events.filter(isRealRead).map(event => [event.id, event.at]));
    const tracked = runs.filter(run => isTrackedReport(run, since));

    const schedules = [...Map.groupBy(tracked, run => run.scheduleId)].map(([scheduleId, reports]) =>
      scheduleAttention(scheduleId, reports, readTimes, trackedLongEnough));

    this.save(schedules, since);
    return schedules;
  }

  // Agents read this file; rewriting it only on change keeps a refresh from touching the disk.
  save(schedules, since) {
    const signature = JSON.stringify(schedules);
    if (signature === this.savedSignature) return;
    try {
      atomicJson(this.attentionFile, { version: 1, trackingSince: new Date(since).toISOString(), schedules });
      this.savedSignature = signature;
    } catch {
      /* The dashboard keeps its live rollup. */
    }
  }
}
