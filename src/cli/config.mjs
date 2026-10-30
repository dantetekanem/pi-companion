import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cadences, validateBinding } from './schedules.mjs';
import { resolveDataRoot } from './migration/admission.mjs';

export const defaultRoot = () => process.env.COMPANION_HOME || join(homedir(), '.companion');
export const legacySources = (home = homedir()) => [
  join(home, '.companion-schedules.md'),
  join(home, '.companion-notes'),
  join(home, '.companion-reports-updates.md'),
  join(home, '.pi', 'agent', 'companion'),
];

export function atomicJson(file, value, { exclusive = false } = {}) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    if (exclusive) linkSync(temporary, file);
    else renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function loadConfig(root) {
  root = resolveDataRoot(root);
  const file = join(root, 'config.json');
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > 65536) throw Error('Companion configuration must be a bounded regular file.');
  return validateConfig(JSON.parse(readFileSync(file, 'utf8')), { allowLegacyHarness: true });
}

export function validateConfig(config, { allowLegacyHarness = false } = {}) {
  if (
    config.version !== 2
    || !Number.isFinite(Date.parse(config.initializedAt))
    || !isAbsolute(config.main?.cwd ?? '')
  ) {
    throw Error('Invalid Companion configuration.');
  }
  validateBinding({ harness: 'pi', ...config.main }, { allowLegacyHarness });
  validateBinding(config.background, { allowLegacyHarness });
  // Jobs have no automatic deadline; a timeoutMs left in older configs is ignored.
  if (!Number.isInteger(config.concurrency) || config.concurrency < 1 || config.concurrency > 4) {
    throw Error('Invalid execution limits.');
  }
  return config;
}

export function initialize(root, { cwd = process.cwd(), now = new Date().toISOString(), legacySources: sources = [] } = {}) {
  root = resolveDataRoot(root);
  if (existsSync(join(root, 'config.json'))) return loadConfig(root);
  if (sources.some(path => existsSync(path))) {
    throw Error('Legacy Companion data detected. A verified migration is required before initialization; nothing was changed.');
  }
  if (!isAbsolute(cwd) || !Number.isFinite(Date.parse(now))) throw Error('Initialization requires an absolute cwd and a valid date.');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!lstatSync(root).isDirectory()) throw Error('Companion home must be a real directory.');
  for (const cadence of cadences) {
    mkdirSync(join(root, 'schedules', cadence), { recursive: true, mode: 0o700 });
  }

  const guide = join(root, 'schedules', 'README.md');
  try {
    writeFileSync(guide, readFileSync(new URL('../prompts/schedule-setup.md', import.meta.url)), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  const config = {
    version: 2,
    initializedAt: now,
    main: { cwd, model: null, effort: 'medium' },
    background: { harness: 'pi', model: null, effort: 'medium' },
    concurrency: 2,
  };
  try {
    atomicJson(join(root, 'config.json'), config, { exclusive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return loadConfig(root);
}
