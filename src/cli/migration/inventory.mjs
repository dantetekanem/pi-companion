import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function legacyLayout(home) {
  if (!isAbsolute(home ?? '')) throw Error('Migration requires an explicit absolute source home.');
  return [
    { category: 'companion', path: join(home, '.pi/agent/companion') },
    { category: 'scheduler', path: join(home, '.pi/agent/state/scheduler/tasks.json') },
    { category: 'registry', path: join(home, '.companion-schedules.md') },
    { category: 'notes', path: join(home, '.companion-notes') },
    { category: 'feed', path: join(home, '.companion-reports-updates.md') },
  ];
}
function readRegular(path, limit) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw Error(`Migration source must be a regular file: ${path}`);
    if (before.size > limit) throw Error(`Migration source exceeds byte limit: ${path}`);
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    let read;
    while (count < bytes.length && (read = readSync(fd, bytes, count, bytes.length - count, null)) > 0) {
      count += read;
    }
    const after = fstatSync(fd);
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
      throw Error(`Migration source changed while reading: ${path}`);
    }
    return { bytes: bytes.subarray(0, count), stat: after };
  } finally {
    closeSync(fd);
  }
}
function classify(category, path, root) {
  if (category !== 'companion') return { category, origin: category };
  const local = relative(root, path);
  if (/^[a-f0-9]{64}\.json$/.test(local)) return { category: 'state', origin: `session:${basename(local, '.json')}` };
  if (local === 'owner.json') return { category: 'owner', origin: 'historical-owner' };
  if (local.startsWith(`durable${sep}`)) return { category: 'durable', origin: 'durable-lifecycle' };
  return { category: 'unknown', origin: `unknown:${sha256(local).slice(0, 24)}` };
}

/** No implicit home, session discovery, normalization or writes. Call only on authorized sources. */
export function inventoryLegacy({ home, references = [], maxFileBytes = 67108864, maxTotalBytes = 2147483648, maxFiles = 50000 }) {
  const roots = legacyLayout(home);
  if (![maxFileBytes, maxTotalBytes, maxFiles].every(value => Number.isSafeInteger(value) && value > 0)) throw Error('Invalid inventory limits.');
  if (!Array.isArray(references) || references.some(item => !['pi-session', 'location', 'review-settings'].includes(item.kind) || !isAbsolute(item.path ?? '')))
    throw Error('Invalid external migration references.');
  const files = [];
  const directories = [];
  const missing = [];
  let totalBytes = 0;
  const visit = (path, root) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw Error(`Migration source symlink is not allowed: ${path}`);
    const local = relative(root.path, path).split(sep).join('/');
    if (stat.isDirectory()) {
      directories.push({ path, category: root.category, relative: local, mode: stat.mode & 0o777, uid: stat.uid });
      for (const name of readdirSync(path).sort()) visit(join(path, name), root);
      return;
    }
    if (!stat.isFile()) throw Error(`Migration source must be a regular file: ${path}`);
    if (files.length >= maxFiles) throw Error('Migration file count limit exceeded.');
    const { bytes, stat: current } = readRegular(path, Math.min(maxFileBytes, maxTotalBytes - totalBytes));
    totalBytes += bytes.length;
    const entry = {
      path,
      root: root.path,
      relative: local,
      ...classify(root.category, path, root.path),
      size: bytes.length,
      sha256: sha256(bytes),
      mode: current.mode & 0o777,
      uid: current.uid,
      mtimeMs: current.mtimeMs,
    };
    if (['state', 'owner', 'scheduler'].includes(entry.category)) {
      try {
        const value = JSON.parse(bytes.toString('utf8'));
        entry.sourceVersion = Number.isInteger(value?.version) ? value.version : null;
        if (entry.category === 'scheduler') entry.shape = Array.isArray(value) ? 'array' : Array.isArray(value?.tasks) ? 'tasks' : 'unknown';
      } catch {
        entry.diagnostic = 'invalid_json';
      }
    }
    files.push(entry);
  };
  for (const root of roots) {
    try {
      lstatSync(root.path);
    } catch (error) {
      if (error.code === 'ENOENT') {
        missing.push(root);
        continue;
      }
      throw error;
    }
    visit(root.path, root);
  }
  const normalizedReferences = references.map(item => ({ kind: item.kind, path: resolve(item.path) }));
  const inventory = {
    version: 1,
    spec: { home: resolve(home), references: normalizedReferences, maxFileBytes, maxTotalBytes, maxFiles },
    files,
    directories,
    missing,
    references: normalizedReferences,
    totalBytes,
  };
  return { ...inventory, fingerprint: sha256(JSON.stringify(inventory)) };
}
export function readSource(entry) {
  const { bytes } = readRegular(entry.path, entry.size);
  if (sha256(bytes) !== entry.sha256) throw Error(`Migration source changed: ${entry.path}`);
  return bytes;
}
export function verifyInventory(inventory) {
  const current = inventoryLegacy(inventory.spec);
  if (current.fingerprint !== inventory.fingerprint) throw Error('Migration sources changed since inventory; activation is blocked.');
  return true;
}
