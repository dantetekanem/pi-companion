import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initialize, loadConfig, validateConfig } from '../src/cli/config.mjs';
import { parseSchedule, loadSchedules, formatSchedule, validateBinding } from '../src/cli/schedules.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'companion-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const metadata = {
  id: 'recap',
  title: 'Morning recap',
  at: '09:00',
  timezone: 'America/Sao_Paulo',
  enabled: false,
  harness: 'pi',
  effort: 'medium',
  cwd: '/project',
  context: ['notes/current.md'],
};
const file = (patch = {}, body = 'Read the approved notes and report useful changes.') =>
  `---\n${JSON.stringify({ ...metadata, ...patch })}\n---\n${body}\n`;

test('initialization is model-free, private, repeatable and does not replace edited configuration', t => {
  const root = fixture(t);
  const now = '2026-10-26T12:00:00.000Z';

  const config = initialize(root, { cwd: '/project', now });

  assert.equal(config.initializedAt, now);
  assert.equal(config.version, 2);
  assert.equal(config.main.cwd, '/project');
  assert.equal(statSync(join(root, 'config.json')).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(root, 'schedules')).sort(), ['README.md', 'daily', 'monthly', 'once', 'weekly']);
  const saved = { ...config, background: { harness: 'claude', model: 'sonnet', effort: 'high' } };
  writeFileSync(join(root, 'config.json'), JSON.stringify(saved));
  assert.deepEqual(initialize(root, { cwd: '/different', now: '2027-01-01T00:00:00.000Z' }), saved);
  assert.deepEqual(loadConfig(root), saved);
  assert.equal(loadSchedules(root).schedules.length, 0);
});

test('active binding validation rejects legacy harnesses while saved config reads preserve identities', t => {
  const root = fixture(t);
  const config = initialize(root, { cwd: root });
  validateBinding({ harness: 'pi', model: 'anthropic/claude-sonnet', effort: 'xhigh' });
  assert.throws(() => validateBinding({ harness: 'claude', effort: 'max' }), /harness.*pi/);
  assert.throws(() => validateBinding({ harness: 'pi', effort: 'max' }), /effort/);
  for (const target of ['main', 'background']) {
    const saved = { ...config, [target]: { ...config[target], harness: 'claude', effort: 'max' } };
    const bytes = JSON.stringify(saved);
    writeFileSync(join(root, 'config.json'), bytes);
    assert.throws(() => validateConfig(saved), /harness.*pi/);
    assert.deepEqual(loadConfig(root), saved);
    assert.equal(readFileSync(join(root, 'config.json'), 'utf8'), bytes);
  }
});

test('legacy admission blocks fresh initialization without reading or mutating the legacy source', t => {
  const base = fixture(t);
  const legacy = join(base, 'legacy.md');
  const root = join(base, 'v2');
  writeFileSync(legacy, 'private legacy bytes');

  assert.throws(() => initialize(root, { cwd: base, legacySources: [legacy] }), /migration/i);
  assert.equal(readFileSync(legacy, 'utf8'), 'private legacy bytes');
  assert.throws(() => statSync(join(root, 'config.json')), { code: 'ENOENT' });
});

test('calendar schedules round-trip without changing recurrence, settings or instructions', () => {
  for (const [cadence, extra] of [['daily', {}], ['weekly', { weekday: 1 }], ['monthly', { day: 31 }]]) {
    const schedule = parseSchedule(file(extra), cadence, `${cadence}/recap.md`);
    assert.equal(schedule.cadence, cadence);
    assert.equal(schedule.timezone, metadata.timezone);
    assert.equal(schedule.enabled, false);
    assert.deepEqual(parseSchedule(formatSchedule(schedule), cadence, schedule.path), schedule);
  }
});

test('one paused schedule can hold multiple times and round-trip in every recurrence folder', t => {
  const root = fixture(t);
  initialize(root, { cwd: root });
  const at = Array.from({ length: 10 }, (_, i) => `${String(i + 8).padStart(2, '0')}:00`);
  for (const [cadence, extra] of [['daily', {}], ['weekly', { weekday: 1 }], ['monthly', { day: 31 }]]) {
    const source = file({ ...extra, at, id: cadence });
    const path = join(root, `schedules/${cadence}/check.md`);
    writeFileSync(path, source);
    const schedule = parseSchedule(source, cadence, path);
    assert.deepEqual(schedule.at, at);
    assert.equal(schedule.enabled, false);
    assert.deepEqual(parseSchedule(formatSchedule(schedule), cadence, path), schedule);
    assert.equal(readFileSync(path, 'utf8'), source);
  }
  assert.deepEqual(loadSchedules(root).counts, { daily: 1, weekly: 1, monthly: 1, once: 0 });
});

test('one paused window schedule round-trips and invalid or conflicting windows fail closed', t => {
  const root = fixture(t);
  initialize(root, { cwd: root });
  const window = { start: '08:00', end: '17:00', everyMinutes: 60 };
  for (const [cadence, extra] of [['daily', {}], ['weekly', { weekday: 1 }], ['monthly', { day: 31 }]]) {
    const source = file({ ...extra, at: undefined, window, id: cadence });
    const path = join(root, `schedules/${cadence}/check.md`);
    writeFileSync(path, source);
    const schedule = parseSchedule(source, cadence, path);
    assert.deepEqual(schedule.window, window);
    assert.equal(schedule.enabled, false);
    assert.deepEqual(parseSchedule(formatSchedule(schedule), cadence, path), schedule);
    assert.equal(readFileSync(path, 'utf8'), source);
  }
  assert.deepEqual(loadSchedules(root).counts, { daily: 1, weekly: 1, monthly: 1, once: 0 });
  for (const invalid of [
    null, [], {}, { ...window, end: '07:00' }, { ...window, start: ['08:00'] },
    { ...window, end: '24:00' }, { ...window, everyMinutes: 0 },
    { ...window, everyMinutes: '60' }, { ...window, everyMinutes: 1.5 },
    { ...window, everyMinutes: 1 }, { ...window, everyMinutes: 1441 },
    { ...window, extra: true },
  ]) {
    assert.throws(() => parseSchedule(file({ at: undefined, window: invalid }), 'daily', 'check.md'), /window/);
  }
  assert.throws(() => parseSchedule(file({ window }), 'daily', 'check.md'), /at.*window|window.*at/);
});

test('validation rejects ambiguous configuration, unsafe input and unsupported effort without guessing', () => {
  const invalidSettings = [
    { at: '24:00' },
    ...[[], ['09:00', '09:00'], ['9:00'], [900], [['09:00']], Array(49).fill('09:00')].map(at => ({ at })),
    { timezone: 'not/a/timezone' },
    { enabled: 'yes' },
    { harness: 'other' },
    { effort: 'ultra' },
    { cwd: 'relative' },
    { context: ['../secret'] },
    { id: '../escape' },
    { unknown: true },
    { title: '\u001b[2J' },
    { model: '-bad' },
  ];
  for (const patch of invalidSettings) {
    assert.throws(() => parseSchedule(file(patch), 'daily', 'daily/recap.md'), /daily\/recap.md/);
  }
  assert.throws(() => parseSchedule(file(), 'weekly', 'weekly/recap.md'), /weekday/);
  assert.deepEqual(parseSchedule(file({ weekday: [1, 2, 3, 4, 5] }), 'weekly', 'weekly/recap.md').weekday, [1, 2, 3, 4, 5]);
  for (const weekday of [[], [1, 1], [7], [1.5], ['1'], [[1]]]) {
    assert.throws(() => parseSchedule(file({ weekday }), 'weekly', 'weekly/recap.md'), /weekday/);
  }
  assert.throws(() => parseSchedule(file({ weekday: [1] }), 'daily', 'daily/recap.md'), /weekday/);
  assert.throws(() => parseSchedule(file({ day: 32 }), 'monthly', 'monthly/recap.md'), /day/);
  assert.throws(() => parseSchedule(file({}, ''), 'daily', 'daily/recap.md'), /instructions/);
  assert.throws(() => parseSchedule(file({}, 'a'.repeat(66000)), 'daily', 'daily/recap.md'), /large/);
});

test('loader reports per-file errors and rejects every conflicting ID or symlink rather than executing one', t => {
  const root = fixture(t);
  initialize(root, { cwd: root });
  writeFileSync(join(root, 'schedules/daily/first.md'), file());
  writeFileSync(join(root, 'schedules/weekly/duplicate.md'), file({ weekday: 1 }));
  writeFileSync(join(root, 'schedules/daily/broken.md'), 'not metadata');
  writeFileSync(join(root, 'schedules/monthly/valid.md'), file({ id: 'monthly', day: 1 }));
  symlinkSync(join(root, 'schedules/monthly/valid.md'), join(root, 'schedules/daily/link.md'));
  const legacyPath = join(root, 'schedules/daily/legacy.md');
  const legacy = file({ id: 'legacy', harness: 'claude', effort: 'max' });
  writeFileSync(legacyPath, legacy);

  const result = loadSchedules(root);

  assert.deepEqual(result.schedules.map(item => item.id), ['monthly']);
  assert.equal(result.errors.length, 5);
  assert.match(result.errors.find(item => item.path === legacyPath).message, /harness.*pi/);
  assert.equal(readFileSync(legacyPath, 'utf8'), legacy);
  assert.ok(result.errors.every(item => item.path && item.message));
  assert.deepEqual(result.counts, { daily: 0, weekly: 0, monthly: 1, once: 0 });
});

test('CLI init/list uses only the explicit temporary root and fails on invalid schedules', t => {
  const root = join(fixture(t), 'data');
  const run = (...args) => spawnSync(process.execPath, ['src/cli/main.mjs', ...args, '--home', root], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(run('init').status, 0);
  const listed = run('schedules');
  assert.equal(listed.status, 0);
  assert.match(listed.stdout, /daily.*0/i);
  assert.doesNotMatch(listed.stdout, /\u001b/);
  writeFileSync(join(root, 'schedules/daily/broken.md'), 'broken');
  assert.equal(run('schedules').status, 1);
  assert.equal(run('unknown-command').status, 1);
});
