import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { collectShutdownReceipt } from './fence.mjs';
import { legacyLayout, sha256 } from './inventory.mjs';

const digest = value => sha256(JSON.stringify(value));
function readStore(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 67108864) throw Error('Scheduler store must be a bounded regular file.');
    const bytes = readFileSync(fd);
    if (bytes.length !== stat.size || fstatSync(fd).mtimeMs !== stat.mtimeMs) throw Error('Scheduler store changed while reading.');
    let value;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw Error('Malformed scheduler store; no records were normalized.');
    }
    return { value, hash: sha256(bytes), mode: stat.mode & 0o777 };
  } finally {
    closeSync(fd);
  }
}
function taskMap(raw) {
  const tasks = Array.isArray(raw) ? raw : raw?.version === 2 && Array.isArray(raw.tasks) ? raw.tasks : null;
  if (!tasks) throw Error('Unsupported raw scheduler container.');
  const map = new Map();
  for (const task of tasks) {
    if (!task || typeof task.id !== 'string' || map.has(task.id)) throw Error('Malformed or duplicate scheduler record.');
    map.set(task.id, task);
  }
  return map;
}
function writeStore(path, value, mode) {
  const temporary = join(dirname(path), `.companion-${randomUUID()}.tmp`);
  try {
    const fd = openSync(temporary, 'wx', mode);
    try {
      writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    const parent = openSync(dirname(path), 'r');
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}
async function shutdownProof(journal, options) {
  const record = journal.record;
  const { migration } = options;
  if (migration?.id !== record.id || migration.fingerprint !== record.manifest.fingerprint || migration.destination !== journal.root
    || !Array.isArray(migration.owners) || JSON.stringify(migration.owners.map(owner => owner.sessionId).sort()) !== JSON.stringify([...record.validation.ownership.owners].sort()))
    throw Error('Scheduler fence ownership scope changed.');
  const root = legacyLayout(record.manifest.spec.home).find(source => source.category === 'companion').path;
  const proof = await collectShutdownReceipt(root, migration, options);
  if (proof.receiptId !== record.validation.ownership.shutdownReceipt) throw Error('Legacy shutdown receipt changed.');
  return proof;
}
async function lockedStore(journal, options, operation) {
  journal.check();
  journal.verifyArchive();
  const record = journal.record;
  if (!record.validation) throw Error('Scheduler fencing requires full validation.');
  await shutdownProof(journal, options);
  const source = record.manifest.files.find(file => file.category === 'scheduler');
  if (!source) {
    if (record.validation.scheduleIds.length) throw Error('Missing scheduler source for selected work.');
    return operation(null, null, () => journal.check());
  }
  let fault;
  const release = await lockfile.lock(source.path, {
    realpath: false,
    stale: 10000,
    update: 2000,
    retries: 0,
    onCompromised: error => { fault = error; },
  });
  const check = () => {
    journal.check();
    if (fault) throw fault;
  };
  try {
    check();
    const result = await operation(source, readStore(source.path), check);
    check();
    return result;
  } finally {
    if (!fault) await release();
  }
}

/** Journal every exact before/after intent before the shared, locked raw-store write. */
export async function fenceSchedules(journal, options) {
  if (journal.record.phase !== 'fencing') throw Error('Scheduler writes require the fencing phase.');
  return lockedStore(journal, options, async (source, current, check) => {
    const record = journal.record;
    const intents = [];
    const replacements = new Map();
    if (source) {
      const original = taskMap(JSON.parse(readFileSync(journal.sourcePath(source), 'utf8')));
      const tasks = taskMap(current.value);
      const ownerFiles = new Set(options.migration.owners.map(owner => owner.sessionFile));
      for (const task of tasks.values()) if (!original.has(task.id) && ownerFiles.has(task.sessionFile)) throw Error('New owner schedule is unattributed; cutover is blocked.');
      for (const taskId of record.validation.scheduleIds) {
        const before = original.get(taskId);
        const present = tasks.get(taskId);
        if (!before || !present || present.runOwner || present.runAttemptId || present.interruptedRun || present.status === 'running') throw Error('Selected scheduler record is missing, running or uncertain.');
        const after = before.enabled ? { ...before, enabled: false, disabledAt: record.createdAt } : before;
        const intent = { taskId, before: digest(before), after: digest(after) };
        const saved = record.intents.find(item => item.taskId === taskId);
        if (saved && JSON.stringify(saved) !== JSON.stringify(intent)) throw Error('Scheduler fence intent changed.');
        if (digest(present) !== intent.before && !(saved && digest(present) === intent.after)) throw Error('Selected scheduler record changed.');
        intents.push(intent);
        if (digest(present) !== intent.after) replacements.set(taskId, after);
      }
    }
    for (const intent of intents) {
      check();
      journal.intent(intent);
    }
    await options.failpoint?.('scheduler-intents');
    check();
    if (source && readStore(source.path).hash !== current.hash) throw Error('Scheduler store changed before its atomic write.');
    if (replacements.size) {
      const raw = current.value;
      const tasks = (Array.isArray(raw) ? raw : raw.tasks).map(task => replacements.get(task.id) ?? task);
      if (!Array.isArray(raw) && (!Number.isSafeInteger(raw.revision) || raw.revision < 0 || raw.revision === Number.MAX_SAFE_INTEGER)) throw Error('Invalid scheduler revision.');
      const after = Array.isArray(raw) ? tasks : { ...raw, tasks, revision: raw.revision + 1, updatedAt: new Date().toISOString() };
      check();
      writeStore(source.path, after, current.mode);
    }
    await options.failpoint?.('scheduler-written');
    check();
    if (source) {
      const tasks = taskMap(readStore(source.path).value);
      for (const intent of intents) if (digest(tasks.get(intent.taskId)) !== intent.after) throw Error('Scheduler fence write could not be verified.');
    }
    return { validationId: record.validation.id, shutdownReceipt: record.validation.ownership.shutdownReceipt, tasks: intents };
  });
}

/** Revalidate actual old records, not merely a saved migration success flag. */
export async function verifyScheduleFence(journal, options) {
  return lockedStore(journal, options, (source, current) => {
    const record = journal.record;
    const tasks = current ? taskMap(current.value) : new Map();
    if (source) {
      const original = taskMap(JSON.parse(readFileSync(journal.sourcePath(source), 'utf8')));
      const ownerFiles = new Set(options.migration.owners.map(owner => owner.sessionFile));
      for (const task of tasks.values()) if (!original.has(task.id) && ownerFiles.has(task.sessionFile)) throw Error('New owner schedule is unattributed; cutover is blocked.');
    }
    if (record.validation.scheduleIds.length !== record.intents.length) throw Error('Scheduler fence intents are incomplete.');
    for (const taskId of record.validation.scheduleIds) {
      const intent = record.intents.find(item => item.taskId === taskId);
      const task = tasks.get(taskId);
      if (!intent || !task || task.enabled || digest(task) !== intent.after) throw Error('Scheduler fence changed.');
    }
    return true;
  });
}
