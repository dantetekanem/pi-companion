import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { atomicJson } from '../config.mjs';
import { sha256 } from './inventory.mjs';

export const legacyControlRoot = root => join(dirname(root), `${basename(root)}-control`);
const directoryFor = (root, options = {}) => options.controlRoot ?? legacyControlRoot(root);
const ownerPath = (directory, id) => join(directory, `${sha256(id)}.json`);
function privateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077)) throw Error('Legacy control directory must be private and not a symlink.');
}
function readPrivate(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 65536 || (stat.mode & 0o077)) throw Error('Invalid private legacy control record.');
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw Error('Malformed legacy control record.');
  }
}
async function gated(directory, operation) {
  privateDirectory(directory);
  let fault;
  const release = await lockfile.lock(directory, {
    retries: { retries: 10, minTimeout: 10, maxTimeout: 200 },
    stale: 300000,
    update: 10000,
    onCompromised: error => { fault = error; },
  });
  const check = () => { if (fault) throw fault; };
  try {
    check();
    const result = await operation(check);
    check();
    return result;
  } finally {
    if (!fault) await release();
  }
}
export function legacyIsFenced(root, controlRoot) {
  // Any marker, including a malformed file or symlink, blocks old execution.
  try {
    lstatSync(join(controlRoot ?? legacyControlRoot(root), 'fence.json'));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
function expectedFence(migration) {
  if (!migration?.id || !/^[a-f0-9]{64}$/.test(migration.fingerprint ?? '') || !isAbsolute(migration.destination ?? '')
    || !Array.isArray(migration.owners) || migration.owners.some(owner => !owner.sessionId || !isAbsolute(owner.sessionFile ?? ''))
    || new Set(migration.owners.map(owner => owner.sessionId)).size !== migration.owners.length) throw Error('Invalid exact migration fence scope.');
  return { version: 1, ...migration };
}
export async function installLegacyFence(root, migration, options) {
  const directory = directoryFor(root, options);
  const expected = expectedFence(migration);
  return gated(directory, check => {
    const path = join(directory, 'fence.json');
    if (existsSync(path)) {
      if (JSON.stringify(readPrivate(path)) !== JSON.stringify(expected)) throw Error('A different migration fence already exists.');
    } else {
      check();
      atomicJson(path, expected, { exclusive: true });
    }
    return expected;
  });
}

export class LegacyOwner {
  static async open(root, identity, options) {
    if (!identity?.sessionId || !isAbsolute(identity.sessionFile ?? '')) throw Error('A saved legacy session identity is required.');
    const directory = directoryFor(root, options);
    return gated(directory, async check => {
      if (legacyIsFenced(root, directory)) throw Error('Legacy Companion is fenced for its v2 upgrade.');
      const owner = new LegacyOwner();
      owner.file = ownerPath(directory, identity.sessionId);
      owner.directory = directory;
      owner.record = { version: 1, ...identity, token: randomUUID(), pid: process.pid, state: 'running', at: new Date().toISOString() };
      owner.release = await lockfile.lock(owner.file, {
        realpath: false,
        retries: 0,
        stale: 300000,
        update: 10000,
        onCompromised: error => { owner.fault = error; },
      });
      try {
        check();
        atomicJson(owner.file, owner.record);
        return owner;
      } catch (error) {
        await owner.release();
        throw error;
      }
    });
  }
  get active() { return !this.fault && !this.closed && !this.closing; }
  async close(drain) {
    if (!this.closing) this.closing = (async () => {
      let released = false;
      try {
        await drain();
        if (this.fault) throw this.fault;
        await gated(this.directory, async check => {
          if (readPrivate(this.file).token !== this.record.token) throw Error('Legacy owner identity changed while shutting down.');
          check();
          atomicJson(this.file, { ...this.record, state: 'stopped', drainedAt: new Date().toISOString() });
          await this.release();
          released = true;
          this.closed = true;
        });
      } finally {
        if (!released && !this.fault) await this.release();
      }
    })();
    return this.closing;
  }
}

/** Pre-protocol confirmation is explicitly operator-attested, never labeled a process probe. */
export async function collectShutdownReceipt(root, migration, { controlRoot, offline } = {}) {
  const directory = directoryFor(root, { controlRoot });
  const expected = expectedFence(migration);
  return gated(directory, async check => {
    if (JSON.stringify(readPrivate(join(directory, 'fence.json'))) !== JSON.stringify(expected)) throw Error('Migration fence scope changed.');
    const offlineValid = offline?.confirmed === true && offline.migrationId === migration.id && offline.fingerprint === migration.fingerprint
      && Number.isFinite(Date.parse(offline.confirmedAt)) && Array.isArray(offline.sessions);
    const sessions = [];
    for (const identity of migration.owners) {
      const path = ownerPath(directory, identity.sessionId);
      if (await lockfile.check(path, { realpath: false, stale: 300000 })) throw Error('A legacy owner is still running; shutdown is required.');
      const record = existsSync(path) ? readPrivate(path) : null;
      if (record?.sessionId === identity.sessionId && record.sessionFile === identity.sessionFile && record.state === 'stopped' && record.drainedAt) {
        sessions.push({ ...identity, state: 'stopped', basis: 'extension-shutdown', token: record.token });
      } else if (offlineValid && offline.sessions.some(item => item.sessionId === identity.sessionId && item.sessionFile === identity.sessionFile)) {
        sessions.push({ ...identity, state: 'stopped', basis: 'operator-attested-offline', attestation: sha256(JSON.stringify(offline)) });
      } else throw Error('Legacy shutdown is unproven; exact offline confirmation is required for this owner.');
    }
    check();
    return {
      kind: 'host-shutdown',
      fingerprint: migration.fingerprint,
      receiptId: sha256(JSON.stringify({ migrationId: migration.id, sessions })),
      observedAt: new Date().toISOString(),
      sessions,
      attested: sessions.some(item => item.basis === 'operator-attested-offline'),
    };
  });
}
