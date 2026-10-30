import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parseCompatibility } from './legacy-schedules.mjs';

export const cadences = ['daily', 'weekly', 'monthly'];
export const efforts = {
  pi: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
};
const legacyClaudeEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];
const fields = new Set(['id', 'title', 'at', 'window', 'timezone', 'enabled', 'harness', 'model', 'effort', 'cwd', 'context', 'weekday', 'day']);
const controls = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
const text = value => typeof value === 'string' && value.trim().length > 0 && !controls.test(value);

export function validateBinding(binding, { allowLegacyHarness = false } = {}) {
  let supportedEfforts;
  if (binding?.harness === 'pi') {
    supportedEfforts = efforts.pi;
  } else if (allowLegacyHarness && binding?.harness === 'claude') {
    supportedEfforts = legacyClaudeEfforts;
  } else {
    throw Error('harness must be pi');
  }
  if (!supportedEfforts.includes(binding.effort)) throw Error(`unsupported ${binding.harness} effort`);
  if (binding.model != null && (!text(binding.model) || binding.model.startsWith('-') || binding.model.length > 200)) {
    throw Error('invalid model');
  }
}

export function scheduleTimes({ at, window }) {
  const validTime = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  if (window !== undefined) {
    if (at !== undefined) throw Error('choose at or window, not both');
    if (!window || Array.isArray(window) || typeof window !== 'object'
      || Object.keys(window).some(key => !['start', 'end', 'everyMinutes'].includes(key))
      || !validTime(window.start) || !validTime(window.end)
      || window.start > window.end || !Number.isInteger(window.everyMinutes)
      || window.everyMinutes < 1 || window.everyMinutes > 1440) {
      throw Error('window needs same-day HH:mm start/end and everyMinutes from 1 to 1440');
    }
    const minutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    const start = minutes(window.start);
    const count = Math.floor((minutes(window.end) - start) / window.everyMinutes) + 1;
    if (count > 48) throw Error('window may contain at most 48 checks per day');
    return Array.from({ length: count }, (_, index) => {
      const minute = start + index * window.everyMinutes;
      return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
    });
  }
  const times = Array.isArray(at) ? at : [at];
  if (!times.length || times.length > 48 || new Set(times).size !== times.length || times.some(time => !validTime(time))) {
    throw Error('at must be HH:mm or a list of 1–48 unique HH:mm times');
  }
  return [...times].sort();
}

export function parseSchedule(source, cadence, path) {
  try {
    if (Buffer.byteLength(source) > 65536) throw Error('schedule is too large');
    if (!cadences.includes(cadence)) throw Error('unknown recurrence folder');
    const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) throw Error('expected JSON metadata between --- lines');
    const value = JSON.parse(match[1]);
    if (!value || Array.isArray(value) || typeof value !== 'object') throw Error('metadata must be an object');
    for (const key of Object.keys(value)) if (!fields.has(key)) throw Error(`unknown setting: ${key}`);
    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(value.id ?? '')) throw Error('invalid id');
    if (!text(value.title) || value.title.length > 160 || /[\r\n]/.test(value.title)) throw Error('invalid title');
    scheduleTimes(value);
    if (!text(value.timezone)) throw Error('timezone is required');
    new Intl.DateTimeFormat('en', { timeZone: value.timezone }).format();
    if (typeof value.enabled !== 'boolean') throw Error('enabled must be true or false');
    validateBinding(value);
    if (!text(value.cwd) || !isAbsolute(value.cwd)) throw Error('cwd must be an absolute path');
    if (
      !Array.isArray(value.context)
      || value.context.length > 20
      || value.context.some(item => !text(item) || isAbsolute(item) || item.split(/[\\/]/).includes('..'))
    ) {
      throw Error('context must contain relative paths within cwd');
    }
    if (cadence === 'weekly'
      ? !Number.isInteger(value.weekday) || value.weekday < 0 || value.weekday > 6
      : value.weekday !== undefined) {
      throw Error('weekday must be 0–6 for weekly schedules only');
    }
    if (cadence === 'monthly'
      ? !Number.isInteger(value.day) || value.day < 1 || value.day > 31
      : value.day !== undefined) {
      throw Error('day must be 1–31 for monthly schedules only');
    }

    const prompt = match[2].trim();
    if (!text(prompt)) throw Error('instructions must be nonempty and contain no terminal controls');
    return { ...value, model: value.model ?? null, cadence, path, prompt };
  } catch (error) {
    throw Error(`${path}: ${error.message}`, { cause: error });
  }
}

export function formatSchedule(schedule) {
  const { cadence, path, prompt, ...metadata } = schedule;
  return `---\n${JSON.stringify(metadata, null, 2)}\n---\n${prompt}\n`;
}

export function loadSchedules(root) {
  const schedules = [];
  const errors = [];
  for (const cadence of [...cadences, 'compatibility']) {
    const directory = join(root, 'schedules', cadence);
    let entries;
    try {
      if (!lstatSync(directory).isDirectory()) throw Error('recurrence path must be a real directory');
      entries = readdirSync(directory).sort();
    } catch (error) {
      if (error.code !== 'ENOENT') errors.push({ path: directory, message: error.message });
      continue;
    }
    const extension = cadence === 'compatibility' ? '.json' : '.md';
    const files = entries.filter(name => name.endsWith(extension) && name !== 'README.md');
    for (const name of files) {
      const path = join(directory, name);
      try {
        const stat = lstatSync(path);
        if (!stat.isFile()) throw Error('schedule must be a regular file, not a symlink');
        if (stat.size > (cadence === 'compatibility' ? 1048576 : 65536)) throw Error('schedule is too large');
        const source = readFileSync(path, 'utf8');
        schedules.push(cadence === 'compatibility'
          ? parseCompatibility(source, path)
          : parseSchedule(source, cadence, path));
      } catch (error) {
        errors.push({ path, message: error.message });
      }
    }
  }
  const ids = new Map();
  for (const schedule of schedules) {
    ids.set(schedule.id, (ids.get(schedule.id) ?? 0) + 1);
  }
  const valid = schedules.filter(schedule => {
    if (ids.get(schedule.id) === 1) return true;
    errors.push({ path: schedule.path, message: `duplicate schedule id: ${schedule.id}` });
    return false;
  });
  const groups = valid.some(item => item.cadence === 'compatibility') ? [...cadences, 'compatibility'] : cadences;
  return {
    schedules: valid,
    errors,
    counts: Object.fromEntries(groups.map(cadence => [
      cadence,
      valid.filter(item => item.cadence === cadence).length,
    ])),
  };
}
