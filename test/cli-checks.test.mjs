import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkHold, logRun, openCheck, scheduleDefinition } from '../src/cli/checks.mjs';

const DAY = 86400000;
const schedule = { id: 'mail', title: 'Mail', prompt: 'Check mail.' };
const start = Date.parse('2026-01-10T12:00:00.000Z');

function home(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'companion-checks-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const blocked = (hour, overrides = {}) => ({
  id: `mail:${hour}`,
  scheduleId: 'mail',
  kind: 'background',
  status: 'completed',
  finishedAt: new Date(start + hour * 3600000).toISOString(),
  result: { status: 'completed', text: 'Blocked: Gmail tools are unavailable.\n\nDetails.' },
  ...overrides,
});
const healthy = hour => blocked(hour, { result: { status: 'completed', text: 'Nothing new.' } });
const logged = (minute, text) => ({
  id: `mail:${minute}`,
  scheduleId: 'mail',
  status: 'completed',
  startedAt: '2026-01-10T12:00:00.000Z',
  finishedAt: `2026-01-10T12:${String(minute).padStart(2, '0')}:00.000Z`,
  result: { text },
});

test('a check opens with its working memory and newest log lines, oldest first', t => {
  const root = home(t);
  for (let minute = 0; minute < 15; minute++) logRun(root, logged(minute, `Run ${minute}`));
  writeFileSync(join(root, 'checks/mail/memory.md'), '- Checkpoint: 2026-01-10\n');

  const check = openCheck(root, 'mail');

  assert.deepEqual(check.memory, {
    path: join(root, 'checks/mail/memory.md'),
    text: '- Checkpoint: 2026-01-10\n',
    truncated: false,
  });
  assert.equal(check.log.length, 12);
  assert.match(check.log[0], /Run 3$/);
  assert.match(check.log.at(-1), /Run 14$/);
});

test('a first run gets an empty memory and a folder to save it in', t => {
  const root = home(t);

  const check = openCheck(root, 'mail');

  assert.deepEqual(check, { memory: { path: join(root, 'checks/mail/memory.md'), text: '', truncated: false }, log: [] });
  assert.equal(statSync(join(root, 'checks/mail')).mode & 0o777, 0o700);
});

test('oversized memory is cut and flagged so it can never break the prompt', t => {
  const root = home(t);
  mkdirSync(join(root, 'checks/mail'), { recursive: true });
  writeFileSync(join(root, 'checks/mail/memory.md'), 'x'.repeat(100000));

  const { memory } = openCheck(root, 'mail');

  assert.equal(memory.truncated, true);
  assert.equal(memory.text.length, 8192);
});

test('log lines record trigger, outcome and cost on one line, even when a run left no report', t => {
  const root = home(t);
  logRun(root, {
    ...logged(5, 'Critical: Rent is short.\n\nDetails stay in the report.'),
    trigger: 'manual',
    cost: { usd: 0.256 },
  });
  logRun(root, {
    ...logged(9, undefined),
    status: 'failed',
    result: { status: 'failed', error: 'Pi did not finish a response (error).' },
  });
  logRun(root, { ...logged(12, undefined), status: 'interrupted', result: undefined, error: 'The previous owner stopped.' });

  const lines = readFileSync(join(root, 'checks/mail/log.md'), 'utf8').trim().split('\n');

  assert.deepEqual(lines, [
    '- 2026-01-10T12:05:00.000Z | manual | completed | 300s | $0.26 | Critical: Rent is short.',
    '- 2026-01-10T12:09:00.000Z | scheduled | failed | 540s | Pi did not finish a response (error).',
    '- 2026-01-10T12:12:00.000Z | scheduled | interrupted | 720s | The previous owner stopped.',
  ]);
  assert.equal(statSync(join(root, 'checks/mail/log.md')).mode & 0o777, 0o600);
});

test('the log stays bounded and keeps its newest whole lines', t => {
  const root = home(t);
  for (let minute = 0; minute < 400; minute++) logRun(root, logged(minute % 60, `${minute} ${'x'.repeat(230)}`));

  const text = readFileSync(join(root, 'checks/mail/log.md'), 'utf8');

  assert.ok(Buffer.byteLength(text) <= 65536);
  assert.match(text, /^- 2026-01-10T12:/);
  assert.match(text.trim().split('\n').at(-1), /\| 399 x+$/);
});

test('only runs of a named check are logged, and an id cannot leave the checks folder', t => {
  const root = home(t);

  logRun(root, { ...logged(1, 'Maintenance'), scheduleId: undefined });
  logRun(root, { ...logged(2, 'Escape'), scheduleId: '../escape' });

  assert.throws(() => statSync(join(root, 'checks')), { code: 'ENOENT' });
  assert.throws(() => statSync(join(root, 'escape')), { code: 'ENOENT' });
});

test('one bad run costs nothing; the hold starts on the second and doubles up to a week', () => {
  assert.equal(checkHold(schedule, [blocked(0)], start), null);
  for (const [count, days] of [[2, 1], [3, 2], [4, 4], [5, 7], [9, 7]]) {
    const runs = Array.from({ length: count }, (_, hour) => blocked(hour));
    const last = start + (count - 1) * 3600000;
    assert.deepEqual(checkHold(schedule, runs, last), {
      until: new Date(last + days * DAY).toISOString(),
      reason: 'Gmail tools are unavailable.',
    });
  }
});

test('a hold ends on time, and any working run clears the streak', () => {
  const runs = [blocked(0), blocked(1)];
  const end = start + 3600000 + DAY;

  assert.ok(checkHold(schedule, runs, end - 1));
  assert.equal(checkHold(schedule, runs, end), null);
  assert.equal(checkHold(schedule, [blocked(0), healthy(1), blocked(2)], start), null);
});

test('failed and incomplete runs stall a check; a report with gaps does not', () => {
  const failed = hour => blocked(hour, { status: 'failed', result: { status: 'failed', error: 'Model overloaded.' } });
  const incomplete = hour => blocked(hour, { status: 'incomplete', result: { status: 'incomplete', text: 'Stopped early.' } });
  const partial = hour => blocked(hour, { result: { status: 'completed', text: 'Useful: One source was unreachable.' } });

  assert.equal(checkHold(schedule, [failed(0), failed(1)], start).reason, 'Model overloaded.');
  assert.equal(checkHold(schedule, [incomplete(0), failed(1)], start).reason, 'Model overloaded.');
  assert.equal(checkHold(schedule, [partial(0), partial(1)], start), null);
});

test('cancelled, skipped and still-running attempts neither extend nor clear a streak', () => {
  const interrupted = blocked(2, { status: 'interrupted', result: { status: 'interrupted' } });
  const skipped = blocked(3, { status: 'incomplete', result: { status: 'incomplete', noModel: true } });
  const running = blocked(4, { status: 'running', result: undefined, finishedAt: undefined });

  assert.ok(checkHold(schedule, [blocked(0), blocked(1), interrupted, skipped, running], start));
  assert.equal(checkHold(schedule, [blocked(0), interrupted, skipped], start), null);
});

test('changing the schedule clears a hold because the next attempt is a different check', () => {
  const definition = scheduleDefinition(schedule);
  const runs = [blocked(0, { definition }), blocked(1, { definition })];

  assert.ok(checkHold(schedule, runs, start));
  assert.equal(checkHold({ ...schedule, prompt: 'Check mail differently.' }, runs, start), null);
});

test('other checks and runs saved before definitions existed still count correctly', () => {
  assert.equal(checkHold(schedule, [blocked(0), blocked(1, { scheduleId: 'other' })], start), null);
  assert.ok(checkHold(schedule, [blocked(0), blocked(1, { definition: scheduleDefinition(schedule) })], start));
});
