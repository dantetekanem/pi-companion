import { lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { sha256 } from './inventory.mjs';
import { MAX_SESSION_BYTES } from './ownership.mjs';

function present(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
function privateBytes(path, limit = 67108864) {
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) || stat.size > limit) throw Error('Migration record must be a private bounded regular file.');
  return readFileSync(path);
}
function privateJson(path) {
  const bytes = privateBytes(path);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw Error('Invalid migration record; inspect it privately.');
  }
}
function privateDirectory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || (stat.mode & 0o077)) throw Error('Activated migration data must use private real directories.');
}
function activation(requested) {
  requested = resolve(requested);
  const nested = basename(requested) === 'data' && basename(dirname(dirname(requested))) === 'migration';
  const home = nested ? dirname(dirname(dirname(requested))) : requested;
  const directory = join(home, 'migration');
  const file = join(directory, 'journal.json');
  const pointer = join(home, 'active.json');
  if (!present(directory) && !present(pointer)) {
    if (nested) throw Error('Migration data has no verified owner.');
    return { home, root: home, record: null };
  }
  if (!present(file) || !present(pointer)) throw Error('Migration is incomplete; verified activation is required before startup.');
  privateDirectory(directory);
  const record = privateJson(file);
  const active = privateJson(pointer);
  if (record.version !== 1 || record.phase !== 'verified') throw Error('Migration has not completed verification.');
  const relative = `migration/${record.id}/data`;
  if (!/^[a-f0-9-]{36}$/.test(record.id) || active.version !== 2 || active.directory !== relative || active.migrationId !== record.id
    || JSON.stringify(active) !== JSON.stringify(record.activation) || active.fingerprint !== record.manifest?.fingerprint
    || !record.validation || active.validationId !== record.validation.id) throw Error('Activation pointer identity does not match its migration.');
  const { id, ...validation } = record.validation;
  if (id !== sha256(JSON.stringify(validation)) || validation.errors?.length || !validation.ownership?.shutdownReceipt
    || !Array.isArray(validation.artifacts) || !record.fence || record.fence.validationId !== id
    || record.fence.shutdownReceipt !== validation.ownership.shutdownReceipt) throw Error('Migration validation identity changed.');
  const root = join(home, relative);
  if (nested && requested !== root) throw Error('Activation points at a different data root.');
  privateDirectory(dirname(root));
  privateDirectory(root);
  const legacy = validation.legacyFence;
  if (!legacy?.controlRoot || !legacy.migration || legacy.migration.id !== record.id || legacy.migration.destination !== home
    || legacy.migration.fingerprint !== active.fingerprint) throw Error('Missing exact legacy fence provenance.');
  const fence = join(legacy.controlRoot, 'fence.json');
  if (!present(fence)) throw Error('Legacy migration fence is missing; startup is blocked.');
  privateDirectory(legacy.controlRoot);
  if (JSON.stringify(privateJson(fence)) !== JSON.stringify({ version: 1, ...legacy.migration })) throw Error('Legacy migration fence changed.');
  return { home, root, record };
}

/** Finite, read-only pointer resolution; it never completes an upgrade as a side effect. */
export const resolveDataRoot = root => activation(root).root;

/** Working config/session files evolve; imported history remains pinned and distinct. */
export function assertRuntimeAdmission(root) {
  const admitted = activation(root);
  if (admitted.record) {
    for (const artifact of admitted.record.validation.artifacts) {
      if (!artifact.path.startsWith('imported/')) continue;
      if (artifact.path.split('/').some(part => !part || part === '..' || part === '.') || artifact.path.includes('\\')) throw Error('Invalid imported history path.');
      if (sha256(privateBytes(join(admitted.root, artifact.path), MAX_SESSION_BYTES)) !== artifact.sha256) throw Error('Immutable imported history changed.');
    }
  }
  return admitted.root;
}

export function adoptedSession(root) {
  const admitted = activation(root);
  if (!admitted.record) return null;
  const indexPath = 'imported/sessions/index.json';
  const artifact = admitted.record.validation.artifacts.find(item => item.path === indexPath);
  if (!artifact || sha256(privateBytes(join(admitted.root, indexPath))) !== artifact.sha256) throw Error('Imported session identity changed.');
  const index = privateJson(join(admitted.root, indexPath));
  const expected = admitted.record.validation.ownership.main;
  if (index.main?.sessionId !== expected?.sessionId || index.main?.sha256 !== expected?.sha256 || index.main?.path !== 'sessions/main.jsonl')
    throw Error('Adopted main identity is missing or changed.');
  return { sessionId: expected.sessionId, sessionFile: join(admitted.root, 'sessions/main.jsonl') };
}
