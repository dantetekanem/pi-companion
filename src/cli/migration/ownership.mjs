import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { readSource, sha256 } from './inventory.mjs';

// Long-running Companion conversations exceed 64 MiB within days.
export const MAX_SESSION_BYTES = 268435456;

/** Identity only. Live main conversations grow without bound, so startup reads just the header line. */
export function readSessionHeader(path) {
  if (!isAbsolute(path ?? '')) throw Error('Select an absolute saved Pi session path.');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw Error('Selected Pi session must be a regular file.');
    const bytes = Buffer.alloc(65536);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    const newline = bytes.subarray(0, count).indexOf(10);
    let header;
    try {
      header = JSON.parse(bytes.subarray(0, newline === -1 ? count : newline).toString('utf8'));
    } catch {
      throw Error('Selected Pi session header is invalid.');
    }
    if (header?.type !== 'session' || typeof header.id !== 'string' || !header.id) throw Error('Selected Pi session header is invalid.');
    return { sessionId: header.id, cwd: header.cwd, version: header.version };
  } finally {
    closeSync(fd);
  }
}

export function pinSession(path) {
  if (!isAbsolute(path ?? '')) throw Error('Select an absolute saved Pi session path.');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_SESSION_BYTES) throw Error('Selected Pi session must be a bounded regular file.');
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    let count;
    while (size < bytes.length && (count = readSync(fd, bytes, size, bytes.length - size, null)) > 0) {
      size += count;
    }
    const after = fstatSync(fd);
    if (size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.size !== stat.size) throw Error('Selected Pi session changed while reading.');
    const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)).split('\n');
    let header;
    try {
      header = JSON.parse(lines.shift());
      for (const line of lines) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line);
        if (!entry || typeof entry !== 'object' || typeof entry.type !== 'string' || entry.type === 'session') throw Error('Invalid entry.');
      }
    } catch {
      throw Error('Selected Pi session header or entry is invalid.');
    }
    if (header.type !== 'session' || ![1, 2, 3].includes(header.version) || typeof header.id !== 'string' || !header.id
      || !isAbsolute(header.cwd ?? '')) throw Error('Selected Pi session identity or format is unsupported.');
    return {
      sessionId: header.id,
      sessionFile: path,
      cwd: header.cwd,
      version: header.version,
      size,
      sha256: sha256(bytes.subarray(0, size)),
      origin: `session:${sha256(header.id)}`,
    };
  } finally {
    closeSync(fd);
  }
}

/** Validate a trusted host's shutdown receipt; this function does not stop or probe processes. */
export function validateOwnership({ manifest, selection, quiescence, checkpoint = null }) {
  const main = pinSession(selection?.sessionFile);
  if (selection?.sessionId !== main.sessionId) throw Error('Selected Pi session identity does not match its saved header.');
  const required = new Set([main.sessionId]);
  const warnings = [];
  const ownerFile = manifest.files.find(entry => entry.category === 'owner');
  let historicalClaim = null;
  if (ownerFile) {
    try {
      historicalClaim = JSON.parse(readSource(ownerFile).toString('utf8'));
    } catch {
      throw Error('Historical owner claim is malformed; resolve its provenance before adoption.');
    }
    if (historicalClaim.version !== 1 || typeof historicalClaim.sessionId !== 'string' || !historicalClaim.sessionId) throw Error('Historical owner format is unsupported.');
    required.add(historicalClaim.sessionId);
    if (historicalClaim.sessionId !== main.sessionId) warnings.push('historical_owner_differs');
  }
  const database = manifest.files.find(entry => entry.category === 'durable' && entry.path.endsWith('companion.sqlite'));
  if (database) {
    if (!checkpoint || checkpoint.sha256 !== database.sha256 || !checkpoint.lifecycle) throw Error('Read the pinned Durable checkpoint before adopting ownership.');
    const lifecycle = checkpoint.lifecycle;
    if (lifecycle.setup === 'requested' || (lifecycle.taskId && checkpoint.controlStatus !== 'terminal')
      || (checkpoint.controlStatus && checkpoint.controlStatus !== 'terminal')
      || (checkpoint.controlOutcome && checkpoint.controlOutcome !== 'completed')) throw Error('Legacy control or setup is active or uncertain.');
    if (lifecycle.owner?.sessionId) required.add(lifecycle.owner.sessionId);
  } else if (checkpoint) throw Error('Checkpoint has no matching inventory source.');
  if (quiescence?.kind !== 'host-shutdown' || !quiescence.receiptId || !Number.isFinite(Date.parse(quiescence.observedAt))
    || !Array.isArray(quiescence.sessions)) throw Error('A scoped host shutdown receipt is required to establish quiescence.');
  if (quiescence.fingerprint !== manifest.fingerprint) throw Error('Shutdown receipt fingerprint does not match this source scope.');
  const stopped = new Set();
  for (const owner of quiescence.sessions) {
    if (typeof owner.sessionId !== 'string' || owner.state !== 'stopped') throw Error('An old owner is active or has not been confirmed stopped.');
    stopped.add(owner.sessionId);
  }
  for (const id of required) if (!stopped.has(id)) throw Error('An old owner lacks a confirmed shutdown receipt.');
  const mappedOrigins = new Set([...stopped].map(id => `session:${sha256(id)}`));
  for (const file of manifest.files.filter(entry => entry.category === 'state')) {
    if (!mappedOrigins.has(file.origin)) throw Error(`Unmapped legacy origin has no confirmed stopped owner: ${file.origin}`);
  }
  return {
    version: 1,
    fingerprint: manifest.fingerprint,
    main,
    historicalClaim,
    warnings,
    references: manifest.references,
    owners: [...stopped],
    shutdownReceipt: quiescence.receiptId,
    checkpoint: checkpoint ? {
      sha256: checkpoint.sha256,
      lifecycle: checkpoint.lifecycle,
      controlStatus: checkpoint.controlStatus,
      controlOutcome: checkpoint.controlOutcome ?? null,
    } : null,
  };
}
