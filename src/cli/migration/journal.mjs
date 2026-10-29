import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { atomicJson } from '../config.mjs';
import { legacyLayout, readSource, sha256, verifyInventory } from './inventory.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const sorted = values => [...values].sort();
const sameIds = (left, right) => Array.isArray(left) && Array.isArray(right) && new Set(left).size === left.length
  && new Set(right).size === right.length && JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
function syncDirectory(path) {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || (stat.mode & 0o077)) throw Error(`Migration directory must be private and not a symlink: ${path}`);
}
function atomicBytes(path, bytes, replace = false) {
  privateDirectory(dirname(path));
  if (existsSync(path)) {
    if (!lstatSync(path).isFile()) throw Error('Migration output must be a regular file.');
    if (sha256(readFileSync(path)) === sha256(bytes)) return;
    if (!replace) throw Error(`Existing migration output changed: ${path}`);
  }
  const temporaryDirectory = join(dirname(path), '..', '.temporary');
  privateDirectory(temporaryDirectory);
  const temporary = join(temporaryDirectory, randomUUID());
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (replace) renameSync(temporary, path);
    else linkSync(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    rmSync(temporary, { force: true });
  }
}
function pinnedFile(path, digest, size) {
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) || (size !== undefined && stat.size !== size) || sha256(readFileSync(path)) !== digest)
    throw Error(`Migration output changed or is not private: ${path}`);
}

function physicalPath(path) {
  let ancestor = resolve(path);
  const missing = [];
  while (true) {
    try {
      lstatSync(ancestor);
      break;
    } catch (error) {
      const parent = dirname(ancestor);
      if (error.code !== 'ENOENT' || parent === ancestor) throw error;
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
  return join(realpathSync(ancestor), ...missing);
}

/** Owns staging, not process shutdown or scheduler mutation. Cutover supplies verified receipts. */
export class MigrationJournal {
  static async open(root, manifest, { selection, failpoint = () => {} } = {}) {
    root = resolve(root);
    const destination = physicalPath(root);
    for (const source of legacyLayout(manifest.spec.home)) {
      const local = relative(physicalPath(source.path), destination);
      if (!local || (!local.startsWith(`..${sep}`) && local !== '..' && !isAbsolute(local))) {
        throw Error('Migration destination cannot be inside a source tree.');
      }
    }
    const journal = new MigrationJournal();
    journal.root = root;
    journal.directory = join(root, 'migration');
    journal.failpoint = failpoint;
    privateDirectory(journal.directory);
    try {
      journal.release = await lockfile.lock(journal.directory, {
        retries: 0,
        stale: 300000,
        update: 10000,
        onCompromised: error => { journal.fault = error; },
      });
    } catch (error) {
      if (error.code === 'ELOCKED') throw Error('Migration is already locked by another owner.');
      throw error;
    }
    journal.file = join(journal.directory, 'journal.json');
    try {
      if (existsSync(journal.file)) {
        const stat = lstatSync(journal.file);
        if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 67108864) throw Error('Invalid private migration journal.');
        journal._record = JSON.parse(readFileSync(journal.file, 'utf8'));
        if (journal._record.version !== 1 || !/^[a-f0-9-]{36}$/.test(journal._record.id)
          || JSON.stringify(journal._record.selection) !== JSON.stringify(selection)
          || (journal._record.phase !== 'verified' && journal._record.manifest.fingerprint !== manifest.fingerprint)
          || journal._record.manifest.spec.home !== manifest.spec.home) throw Error('Migration identity, source fingerprint or selection changed.');
      } else {
        if (!selection?.sessionId || !isAbsolute(selection.sessionFile ?? '')) throw Error('Migration requires an explicit saved-session selection.');
        journal._record = {
          version: 1,
          id: randomUUID(),
          phase: 'inventory',
          selection,
          manifest,
          createdAt: new Date().toISOString(),
          validation: null,
          intents: [],
          fence: null,
        };
        journal.save(journal._record);
      }
      journal.stageRoot = join(journal.directory, journal._record.id);
      journal.dataRoot = join(journal.stageRoot, 'data');
      privateDirectory(journal.dataRoot);
      return journal;
    } catch (error) {
      await journal.release();
      throw error;
    }
  }

  get record() {
    return clone(this._record);
  }

  check() {
    if (this.closed) throw Error('Migration journal is closed.');
    if (this.fault) throw this.fault;
  }

  save(next) {
    this.check();
    atomicJson(this.file, next);
    syncDirectory(this.directory);
    this._record = clone(next);
    this.failpoint(next.phase);
  }
  dataPath(path) {
    if (typeof path !== 'string' || !path || isAbsolute(path) || path.split(/[\\/]/).some(part => !part || part === '..' || part === '.')) throw Error('Invalid staged data path.');
    let parent = this.dataRoot;
    for (const part of path.split('/').slice(0, -1)) {
      parent = join(parent, part);
      privateDirectory(parent);
    }
    return join(this.dataRoot, path);
  }
  sourcePath(entry) {
    if (!this._record.manifest.files.some(file => file.path === entry.path && file.sha256 === entry.sha256)) throw Error('Source is outside this migration manifest.');
    return join(this.stageRoot, 'originals', sha256(entry.path));
  }
  async stage() {
    this.check();
    if (!['inventory', 'staged'].includes(this._record.phase)) throw Error('Staging is closed after fencing begins.');
    verifyInventory(this._record.manifest);
    for (const entry of this._record.manifest.files) {
      atomicBytes(this.sourcePath(entry), readSource(entry));
      this.failpoint(`source:${entry.path}`);
    }
    this.verifyArchive();
    verifyInventory(this._record.manifest);
    if (this._record.phase === 'inventory') this.save({ ...this._record, phase: 'staged' });
  }
  verifyArchive() {
    this.check();
    const entries = this._record.manifest.files;
    const directory = join(this.stageRoot, 'originals');
    privateDirectory(directory);
    if (readdirSync(directory).length !== entries.length) throw Error('Migration archive file count changed.');
    for (const entry of entries) pinnedFile(this.sourcePath(entry), entry.sha256, entry.size);
    return true;
  }
  writeData(path, bytes, { replace = false } = {}) {
    this.check();
    if (!['inventory', 'staged'].includes(this._record.phase)) throw Error('Staged data cannot change after fencing begins.');
    atomicBytes(this.dataPath(path), bytes, replace);
    if (this._record.validation) this.save({ ...this._record, validation: null });
    return { path, sha256: sha256(bytes) };
  }
  validate(receipt) {
    this.check();
    if (this._record.phase !== 'staged') throw Error('Validation requires completed staging.');
    if (!sameIds(receipt.scheduleIds, receipt.validatedScheduleIds)) throw Error('Every schedule must validate before cutover.');
    if (receipt.fingerprint !== this._record.manifest.fingerprint || !Array.isArray(receipt.errors) || receipt.errors.length
      || receipt.ownership?.fingerprint !== receipt.fingerprint || !receipt.ownership.shutdownReceipt
      || !Array.isArray(receipt.artifacts) || !receipt.artifacts.length) throw Error('Incomplete source, ownership or output validation.');
    this.verifyArchive();
    verifyInventory(this._record.manifest);
    for (const artifact of receipt.artifacts) pinnedFile(this.dataPath(artifact.path), artifact.sha256);
    const { id: _oldId, ...fields } = receipt;
    const validation = { ...clone(fields), id: sha256(JSON.stringify(fields)) };
    this.save({ ...this._record, validation });
    return validation;
  }
  verifyData() {
    for (const artifact of this._record.validation.artifacts) pinnedFile(this.dataPath(artifact.path), artifact.sha256);
  }
  beginFence() {
    this.check();
    if (this._record.phase === 'fencing') return;
    if (this._record.phase !== 'staged' || !this._record.validation) throw Error('Fencing requires validated staging.');
    this.verifyArchive();
    this.verifyData();
    verifyInventory(this._record.manifest);
    this.save({ ...this._record, phase: 'fencing' });
  }
  intent(receipt) {
    this.check();
    if (this._record.phase !== 'fencing') throw Error('Disable intents require fencing state.');
    if (!this._record.validation.scheduleIds.includes(receipt.taskId) || !/^[a-f0-9]{64}$/.test(receipt.before)
      || !/^[a-f0-9]{64}$/.test(receipt.after)) throw Error('Invalid exact-task fence intent.');
    const previous = this._record.intents.find(item => item.taskId === receipt.taskId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(receipt)) throw Error('Conflicting fence intent requires reconciliation.');
    if (!previous) this.save({ ...this._record, intents: [...this._record.intents, clone(receipt)] });
  }
  fenced(receipt) {
    this.check();
    if (this._record.phase !== 'fencing' || receipt.validationId !== this._record.validation.id
      || receipt.shutdownReceipt !== this._record.validation.ownership.shutdownReceipt
      || !Array.isArray(receipt.tasks) || !sameIds(receipt.tasks.map(item => item.taskId), this._record.validation.scheduleIds)) throw Error('Incomplete or mismatched schedule fence receipts.');
    for (const task of receipt.tasks) {
      if (!this._record.intents.some(intent => JSON.stringify(intent) === JSON.stringify(task))) throw Error('Fence receipt has no matching durable intent.');
    }
    this.save({ ...this._record, phase: 'fenced', fence: clone(receipt) });
  }
  activate() {
    this.check();
    if (this._record.phase !== 'fenced') throw Error('Activation requires fenced state.');
    this.verifyArchive();
    this.verifyData();
    const active = {
      version: 2,
      migrationId: this._record.id,
      directory: relative(this.root, this.dataRoot),
      fingerprint: this._record.manifest.fingerprint,
      validationId: this._record.validation.id,
    };
    const file = join(this.root, 'active.json');
    if (existsSync(file)) {
      if (JSON.stringify(JSON.parse(readFileSync(file, 'utf8'))) !== JSON.stringify(active)) throw Error('Another activation already exists.');
    } else {
      atomicJson(file, active, { exclusive: true });
      syncDirectory(this.root);
    }
    this.save({ ...this._record, phase: 'committed', activation: active });
    return active;
  }
  verifyActivation() {
    this.check();
    if (!['committed', 'verified'].includes(this._record.phase)) throw Error('No committed activation to verify.');
    const active = JSON.parse(readFileSync(join(this.root, 'active.json'), 'utf8'));
    if (JSON.stringify(active) !== JSON.stringify(this._record.activation)) throw Error('Activation pointer changed.');
    if (this._record.phase === 'committed') {
      this.verifyArchive();
      this.verifyData();
      this.save({ ...this._record, phase: 'verified' });
    }
    return true;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.release();
  }
}
