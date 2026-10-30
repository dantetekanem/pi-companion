import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { reportText, reportTriage, runOutcomeText, writePrivate } from './reports.mjs';

const MAX_MEMORY_BYTES = 8192;
const MAX_LOG_BYTES = 65536;
const MAX_SUMMARY_LENGTH = 240;
const LOG_LINES = 12;
const HOLD_AFTER_STALLED_RUNS = 2;
const MAX_HOLD_DAYS = 7;
const DAY_MS = 86400000;

const checkDirectory = (root, id) => join(root, 'checks', id);
const memoryPath = (root, id) => join(checkDirectory(root, id), 'memory.md');
const logPath = (root, id) => join(checkDirectory(root, id), 'log.md');

function runSummary(run) {
  const [firstLine] = reportText(runOutcomeText(run) || 'No result text.').split('\n', 1);
  return firstLine.trim().slice(0, MAX_SUMMARY_LENGTH);
}

function logLine(run) {
  const seconds = Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000);
  const fields = [run.finishedAt, run.trigger ?? 'scheduled', run.status, `${seconds}s`];
  if (Number.isFinite(run.cost?.usd)) fields.push(`$${run.cost.usd.toFixed(2)}`);
  fields.push(runSummary(run));
  return `- ${fields.join(' | ')}\n`;
}

function keepNewestLogLines(file) {
  const text = readFileSync(file, 'utf8');
  const keepFrom = text.indexOf('\n', text.length - MAX_LOG_BYTES / 2) + 1;
  writePrivate(file, text.slice(keepFrom));
}

function readCheckMemory(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return { path, text: '', truncated: false };
  if (!stat.isFile()) throw Error('Check memory must be a regular file.');

  const file = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(MAX_MEMORY_BYTES);
    const bytes = readSync(file, buffer, 0, MAX_MEMORY_BYTES, 0);
    return {
      path,
      text: buffer.subarray(0, bytes).toString('utf8'),
      truncated: stat.size > MAX_MEMORY_BYTES,
    };
  } finally {
    closeSync(file);
  }
}

function readCheckLog(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return [];
  if (!stat.isFile()) throw Error('Check log must be a regular file.');
  return readFileSync(path, 'utf8').trim().split('\n').slice(-LOG_LINES);
}

/** What earlier runs left for this one. Every run is a fresh process, so this is all it inherits. */
export function openCheck(root, id) {
  mkdirSync(checkDirectory(root, id), { recursive: true, mode: 0o700 });
  return {
    memory: readCheckMemory(memoryPath(root, id)),
    log: readCheckLog(logPath(root, id)),
  };
}

/** Companion writes the log so no agent has to reconstruct run history from transcripts or the database. */
export function logRun(root, run) {
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(run.scheduleId ?? '')) return;
  try {
    mkdirSync(checkDirectory(root, run.scheduleId), { recursive: true, mode: 0o700 });
    const file = logPath(root, run.scheduleId);
    appendFileSync(file, logLine(run), { mode: 0o600 });
    if (statSync(file).size > MAX_LOG_BYTES) keepNewestLogLines(file);
  } catch {
    // The receipt is already committed; a log problem cannot change the outcome.
  }
}

export const scheduleDefinition = schedule => createHash('sha256').update(JSON.stringify(schedule)).digest('hex');

const stalled = run => ['failed', 'incomplete'].includes(run.status) || reportTriage(run)?.level === 'blocked';
// A cancelled, skipped or unfinished attempt says nothing about whether the check works.
const inconclusive = run => !run.finishedAt || run.status === 'interrupted' || run.result?.noModel;

function stalledStreak(attempts, definition) {
  const cleared = attempts.findIndex(run => !stalled(run) || (run.definition && run.definition !== definition));
  return cleared === -1 ? attempts.length : cleared;
}

/** Repeating a blocked check costs money and tells the user nothing new, so waits double from a day up to a week. */
export function checkHold(schedule, runs, now) {
  const attempts = runs
    .filter(run => run.scheduleId === schedule.id && !inconclusive(run))
    .toSorted((a, b) => b.finishedAt.localeCompare(a.finishedAt));
  const streak = stalledStreak(attempts, scheduleDefinition(schedule));
  if (streak < HOLD_AFTER_STALLED_RUNS) return null;

  const [latest] = attempts;
  const days = Math.min(2 ** (streak - HOLD_AFTER_STALLED_RUNS), MAX_HOLD_DAYS);
  const until = Date.parse(latest.finishedAt) + days * DAY_MS;
  if (until <= now) return null;

  return {
    until: new Date(until).toISOString(),
    reason: reportTriage(latest)?.message ?? runSummary(latest),
  };
}
