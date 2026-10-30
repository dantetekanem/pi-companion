import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Telemetry } from '../src/cli/telemetry.mjs';

const DAY = 86400000;
const started = Date.parse('2026-10-01T00:00:00Z');
const later = days => started + days * DAY;

function dataRoot(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'companion-telemetry-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'runtime'), { mode: 0o700 });
  return root;
}

const run = (id, day, patch = {}) => ({
  id,
  kind: 'background',
  scheduleId: 'digest',
  title: 'Digest',
  status: 'completed',
  finishedAt: new Date(later(day)).toISOString(),
  cost: { usd: 0.5 },
  result: { status: 'completed', text: 'Useful: Something happened.' },
  ...patch,
});
const dailyRuns = (count, patch) => Array.from({ length: count }, (_, day) => run(`run-${day}`, day + 1, patch));
const digest = rollup => rollup.find(item => item.scheduleId === 'digest');

test('a check nobody opens is flagged once enough reports and days have passed', t => {
  const telemetry = Telemetry.open(dataRoot(t), started);

  assert.equal(digest(telemetry.attention(dailyRuns(4), later(30))).ignored, false, 'too few reports to judge');
  assert.equal(digest(telemetry.attention(dailyRuns(6), later(6))).ignored, false, 'tracked for too few days');

  const flagged = digest(telemetry.attention(dailyRuns(6), later(8)));
  assert.equal(flagged.ignored, true);
  assert.deepEqual([flagged.title, flagged.reports, flagged.read, flagged.usd], ['Digest', 6, 0, 3]);
});

test('only a real look counts as reading a report', t => {
  const telemetry = Telemetry.open(dataRoot(t), started);
  const runs = dailyRuns(6);

  telemetry.recordReportRead({ id: 'run-5', dwellMs: 900 }, later(7));
  assert.equal(digest(telemetry.attention(runs, later(8))).read, 0, 'a brief open is a misclick');

  telemetry.recordReportRead({ id: 'run-5', dwellMs: 20000 }, later(7));
  telemetry.recordReportRead({ id: 'run-4', dwellMs: 20000 }, later(7));
  const reviewed = digest(telemetry.attention(runs, later(8)));
  assert.equal(reviewed.read, 2);
  assert.equal(reviewed.ignored, false);
  assert.equal(reviewed.lastReadAt, new Date(later(7)).toISOString());
});

test('messaging about a report counts as reading it, however briefly it was open', t => {
  const telemetry = Telemetry.open(dataRoot(t), started);
  const runs = dailyRuns(6);

  telemetry.recordReportRead({ id: 'run-5', dwellMs: 900 }, later(7));
  telemetry.recordReportDiscussed('run-5', later(7));
  telemetry.recordReportDiscussed('run-4', later(7));

  const reviewed = digest(telemetry.attention(runs, later(8)));
  assert.equal(reviewed.read, 2);
  assert.equal(reviewed.ignored, false);
});

test('the judgment follows recent reports, so a check can become ignored and recover', t => {
  const telemetry = Telemetry.open(dataRoot(t), started);
  const runs = dailyRuns(20);

  for (let day = 0; day < 5; day++) telemetry.recordReportRead({ id: `run-${day}`, dwellMs: 20000 }, later(day + 1));
  assert.equal(digest(telemetry.attention(runs, later(21))).ignored, true, 'early reads do not excuse the last ten reports');

  telemetry.recordReportRead({ id: 'run-19', dwellMs: 20000 }, later(21));
  telemetry.recordReportRead({ id: 'run-18', dwellMs: 20000 }, later(21));
  telemetry.recordReportRead({ id: 'run-17', dwellMs: 20000 }, later(21));
  assert.equal(digest(telemetry.attention(runs, later(22))).ignored, false);
});

test('critical findings and requested runs show a check still matters', t => {
  const telemetry = Telemetry.open(dataRoot(t), started);
  const critical = { status: 'completed', text: 'Critical: The bank flagged a transfer.' };

  const alerted = dailyRuns(6).map((item, index) => (index === 2 ? { ...item, result: critical } : item));
  assert.equal(digest(telemetry.attention(alerted, later(8))).ignored, false);

  const requested = dailyRuns(6).map((item, index) => (index === 2 ? { ...item, trigger: 'manual' } : item));
  assert.equal(digest(telemetry.attention(requested, later(8))).ignored, false);
});

test('only finished scheduled reports since tracking began are judged', t => {
  const telemetry = Telemetry.open(dataRoot(t), started);
  const runs = [
    ...Array.from({ length: 8 }, (_, index) => run(`before-${index}`, -index - 1)),
    run('failed', 2, { status: 'failed' }),
    run('running', 3, { status: 'running', finishedAt: undefined }),
    run('chat', 3, { kind: 'main', scheduleId: undefined }),
  ];

  assert.deepEqual(telemetry.attention(runs, later(30)), []);
});

test('nothing-new reports are counted so a silent check can be judged', t => {
  const telemetry = Telemetry.open(dataRoot(t), started);
  const quiet = { status: 'completed', text: 'Nothing new.' };

  const rollup = digest(telemetry.attention(dailyRuns(6, { result: quiet }), later(8)));
  assert.equal(rollup.nothingNew, 6);
  assert.equal(rollup.ignored, true);
});

test('tracking start and reads survive a restart, and files stay private', t => {
  const root = dataRoot(t);
  const first = Telemetry.open(root, started);
  first.recordReportRead({ id: 'run-5', dwellMs: 20000 }, later(7));
  first.attention(dailyRuns(6), later(8));

  const reopened = Telemetry.open(root, later(100));
  assert.equal(digest(reopened.attention(dailyRuns(6), later(101))).read, 1);
  assert.equal(digest(reopened.attention(dailyRuns(6), later(8))).ignored, true, 'the original start still counts');
  for (const name of ['telemetry.jsonl', 'report-attention.json']) {
    assert.equal(statSync(join(root, 'runtime', name)).mode & 0o777, 0o600);
  }
  const saved = JSON.parse(readFileSync(join(root, 'runtime/report-attention.json'), 'utf8'));
  assert.equal(saved.schedules[0].scheduleId, 'digest');
});

test('a damaged line loses that event, not the whole history', t => {
  const root = dataRoot(t);
  Telemetry.open(root, started).recordReportRead({ id: 'run-5', dwellMs: 20000 }, later(7));
  appendFileSync(join(root, 'runtime/telemetry.jsonl'), '{"type":"report_read"\nnull\n7\n');

  assert.equal(digest(Telemetry.open(root, later(9)).attention(dailyRuns(6), later(9))).read, 1);
});

test('the log stays bounded and keeps its tracking start', t => {
  const root = dataRoot(t);
  const file = join(root, 'runtime/telemetry.jsonl');
  Telemetry.open(root, started);
  const filler = `${JSON.stringify({ type: 'report_read', at: new Date(later(1)).toISOString(), id: 'x'.repeat(200), dwellMs: 1 })}\n`;
  appendFileSync(file, filler.repeat(Math.ceil(1048576 / filler.length)));

  const telemetry = Telemetry.open(root, later(2));
  telemetry.recordReportRead({ id: 'run-5', dwellMs: 20000 }, later(7));

  assert.ok(statSync(file).size < 1048576);
  assert.equal(digest(telemetry.attention(dailyRuns(6), later(8))).read, 1);
  assert.equal(digest(telemetry.attention(dailyRuns(6), later(8))).ignored, true, 'the original start still counts');
  assert.equal(JSON.parse(readFileSync(file, 'utf8').split('\n')[0]).type, 'tracking_started');
});

test('telemetry that cannot be written never stops the dashboard', t => {
  const root = dataRoot(t);
  const telemetry = Telemetry.open(root, started);
  rmSync(join(root, 'runtime'), { recursive: true });
  writeFileSync(join(root, 'runtime'), 'not a directory');

  assert.doesNotThrow(() => telemetry.recordReportRead({ id: 'run-5', dwellMs: 20000 }, later(7)));
  assert.equal(digest(telemetry.attention(dailyRuns(6), later(8))).read, 1);
});
