import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inventoryLegacy, sha256, verifyInventory } from '../src/cli/migration/inventory.mjs';
import { MigrationJournal } from '../src/cli/migration/journal.mjs';
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'companion-journal-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.companion-notes/nested'), { recursive: true });
  writeFileSync(join(home, '.companion-notes/nested/a.md'), 'preserve\n<!-- historical -->\n');
  return {
    home,
    root: join(home, 'v2'),
    manifest: inventoryLegacy({ home }),
    selection: { sessionId: 'selected', sessionFile: join(home, 'saved.jsonl') },
  };
}
async function prepared(journal) {
  await journal.stage();
  const bytes = Buffer.from('{"version":2}\n');
  journal.writeData('config.json', bytes);
  journal.validate({
    fingerprint: journal.record.manifest.fingerprint,
    artifacts: [{ path: 'config.json', sha256: sha256(bytes) }],
    scheduleIds: ['routine'],
    validatedScheduleIds: ['routine'],
    ownership: { fingerprint: journal.record.manifest.fingerprint, shutdownReceipt: 'host-1' },
    errors: [],
  });
}
function fence(journal) {
  journal.beginFence();
  journal.intent({ taskId: 'routine', before: 'a'.repeat(64), after: 'b'.repeat(64) });
  journal.fenced({
    validationId: journal.record.validation.id,
    shutdownReceipt: 'host-1',
    tasks: [{ taskId: 'routine', before: 'a'.repeat(64), after: 'b'.repeat(64) }],
  });
}

test('private staged originals are byte-preserving, exclusive and resumable under one identity', async t => {
  const f = fixture(t), journal = await MigrationJournal.open(f.root, f.manifest, { selection: f.selection });
  await assert.rejects(MigrationJournal.open(f.root, f.manifest, { selection: f.selection }), /already|locked/i);
  await journal.stage();
  const id = journal.record.id, entry = f.manifest.files[0], archived = journal.sourcePath(entry);
  assert.deepEqual(readFileSync(archived), readFileSync(entry.path));
  assert.equal(statSync(archived).mode & 0o777, 0o600);
  assert.equal(statSync(journal.directory).mode & 0o777, 0o700);
  await journal.close();
  const reopened = await MigrationJournal.open(f.root, f.manifest, { selection: f.selection });
  try {
    await reopened.stage();
    assert.equal(reopened.record.id, id);
    assert.equal(reopened.verifyArchive(), true);
  } finally {
    await reopened.close();
  }
});

test('activation requires every schedule, pinned output, scoped ownership and matching fence receipts', async t => {
  const f = fixture(t), journal = await MigrationJournal.open(f.root, f.manifest, { selection: f.selection });
  try {
    assert.throws(() => journal.activate(), /fenced/);
    await prepared(journal);
    assert.throws(() => journal.validate({ ...journal.record.validation, validatedScheduleIds: [] }), /schedule/);
    journal.beginFence();
    assert.throws(() => journal.fenced({ validationId: journal.record.validation.id, shutdownReceipt: 'host-1', tasks: [] }), /fence|schedule/i);
    journal.intent({ taskId: 'routine', before: 'a'.repeat(64), after: 'b'.repeat(64) });
    journal.fenced({ validationId: journal.record.validation.id, shutdownReceipt: 'host-1', tasks: [{ taskId: 'routine', before: 'a'.repeat(64), after: 'b'.repeat(64) }] });
    writeFileSync(join(journal.dataRoot, 'config.json'), 'drift');
    assert.throws(() => journal.activate(), /changed/);
    assert.equal(existsSync(join(f.root, 'active.json')), false);
  } finally {
    await journal.close();
  }
});

test('failure after each durable phase resumes that migration and never creates a second active import', async t => {
  for (const phase of ['inventory', 'staged', 'fencing', 'fenced', 'committed', 'verified']) {
    const f = fixture(t);
    let failed = false;
    let journal;
    const failpoint = at => {
      if (at === phase && !failed) {
        failed = true;
        throw Error(`crash:${at}`);
      }
    };
    try {
      journal = await MigrationJournal.open(f.root, f.manifest, { selection: f.selection, failpoint });
      await prepared(journal);
      fence(journal);
      journal.activate();
      journal.verifyActivation();
    } catch (error) {
      assert.match(error.message, /crash:/);
    } finally {
      await journal?.close();
    }
    const restored = await MigrationJournal.open(f.root, f.manifest, { selection: f.selection });
    try {
      const id = restored.record.id;
      if (restored.record.phase === 'inventory') await prepared(restored);
      else if (restored.record.phase === 'staged' && !restored.record.validation) await prepared(restored);
      if (restored.record.phase === 'staged') fence(restored);
      else if (restored.record.phase === 'fencing') {
        restored.intent({ taskId: 'routine', before: 'a'.repeat(64), after: 'b'.repeat(64) });
        restored.fenced({ validationId: restored.record.validation.id, shutdownReceipt: 'host-1', tasks: [{ taskId: 'routine', before: 'a'.repeat(64), after: 'b'.repeat(64) }] });
      }
      if (restored.record.phase === 'fenced') restored.activate();
      restored.verifyActivation();
      assert.equal(restored.record.id, id);
      assert.equal(restored.record.phase, 'verified');
      assert.equal(JSON.parse(readFileSync(join(f.root, 'active.json'))).migrationId, id);
      assert.equal(readFileSync(f.manifest.files[0].path, 'utf8'), 'preserve\n<!-- historical -->\n');
    } finally {
      await restored.close();
    }
  }
});

test('a destination aliased inside a source is rejected before creating any directories', async t => {
  const f = fixture(t);
  const alias = join(f.home, 'notes-alias');
  const source = join(f.home, '.companion-notes');
  symlinkSync(source, alias, 'dir');

  for (const root of [alias, join(alias, 'new-parent/v2')]) {
    await assert.rejects(async () => {
      const journal = await MigrationJournal.open(root, f.manifest, { selection: f.selection });
      await journal.close();
    }, /destination.*source tree/);
    assert.equal(verifyInventory(f.manifest), true);
  }
  assert.equal(existsSync(join(source, 'new-parent')), false);
});

test('a safe aliased ancestor allows private staging outside the source tree', async t => {
  const f = fixture(t);
  const parent = join(f.home, 'safe-parent');
  const alias = join(f.home, 'safe-alias');
  mkdirSync(parent, { mode: 0o700 });
  symlinkSync(parent, alias, 'dir');

  const journal = await MigrationJournal.open(join(alias, 'new-parent/v2'), f.manifest, { selection: f.selection });
  try {
    await journal.stage();
    assert.equal(journal.verifyArchive(), true);
    assert.equal(verifyInventory(f.manifest), true);
    assert.equal(statSync(journal.directory).mode & 0o777, 0o700);
  } finally {
    await journal.close();
  }
});

test('source drift and a conflicting selection block staging without replacing originals', async t => {
  const f = fixture(t), journal = await MigrationJournal.open(f.root, f.manifest, { selection: f.selection });
  writeFileSync(f.manifest.files[0].path, 'new original');
  await assert.rejects(journal.stage(), /changed/);
  await journal.close();
  await assert.rejects(MigrationJournal.open(f.root, f.manifest, { selection: { ...f.selection, sessionId: 'different' } }), /identity|selection/);
  assert.equal(readFileSync(f.manifest.files[0].path, 'utf8'), 'new original');
});
