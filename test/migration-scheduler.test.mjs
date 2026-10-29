import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { inventoryLegacy, sha256 } from '../src/cli/migration/inventory.mjs';
import { MigrationJournal } from '../src/cli/migration/journal.mjs';
import { installLegacyFence, collectShutdownReceipt, LegacyOwner } from '../src/cli/migration/fence.mjs';
import { fenceSchedules, verifyScheduleFence } from '../src/cli/migration/scheduler.mjs';

async function fixture(t, { active = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'companion-cas-')), home = join(directory, 'old'), root = join(directory, 'new');
  const file = join(home, '.pi/agent/state/scheduler/tasks.json'), legacy = join(home, '.pi/agent/companion'), controlRoot = join(directory, 'control');
  mkdirSync(legacy, { recursive: true });
  mkdirSync(join(file, '..'), { recursive: true });
  const identity = { sessionId: 'selected', sessionFile: join(home, 'selected.jsonl') };
  const task = id => ({ id, scope: 'session', sessionFile: identity.sessionFile, enabled: true, status: 'pending', runCount: 4, nextRun: '2026-11-01T00:00:00Z', unknown: { retain: id } });
  const raw = { version: 2, revision: 17, updatedAt: '2026-10-26T00:00:00Z', unknownMetadata: [null, 'keep'], tasks: [task('task_a'), { ...task('task_b'), enabled: false, disabledAt: '2026-09-01T00:00:00Z' }, task('task_other')] };
  writeFileSync(file, JSON.stringify(raw));
  const manifest = inventoryLegacy({ home }), owner = active ? await LegacyOwner.open(legacy, identity, { controlRoot }) : null;
  const journal = await MigrationJournal.open(root, manifest, { selection: identity });
  t.after(async () => {
    await owner?.close(async () => {});
    await journal.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await journal.stage();
  const migration = { id: journal.record.id, fingerprint: manifest.fingerprint, destination: root, owners: [identity] };
  await installLegacyFence(legacy, migration, { controlRoot });
  const offline = { confirmed: true, migrationId: migration.id, fingerprint: migration.fingerprint, sessions: [identity], confirmedAt: '2026-10-26T00:00:00Z' };
  const proof = active ? { receiptId: 'not-stopped' } : await collectShutdownReceipt(legacy, migration, { controlRoot, offline });
  const artifact = journal.writeData('fixture.json', Buffer.from('{}'));
  journal.validate({
    fingerprint: manifest.fingerprint,
    artifacts: [artifact],
    scheduleIds: ['task_a', 'task_b'],
    validatedScheduleIds: ['task_a', 'task_b'],
    errors: [],
    ownership: { fingerprint: manifest.fingerprint, shutdownReceipt: proof.receiptId, owners: [identity.sessionId] },
  });
  journal.beginFence();
  return { journal, file, raw, manifest, options: { migration, controlRoot, offline } };
}

test('raw CAS disables only selected tasks and preserves unknown metadata, unrelated records and explicit stops', async t => {
  const h = await fixture(t), receipt = await fenceSchedules(h.journal, h.options);
  const after = JSON.parse(readFileSync(h.file, 'utf8'));
  assert.equal(after.tasks[0].enabled, false);
  assert.equal(after.tasks[0].runCount, 4);
  assert.deepEqual(after.tasks[0].unknown, h.raw.tasks[0].unknown);
  assert.deepEqual(after.tasks.slice(1), h.raw.tasks.slice(1));
  assert.deepEqual(after.unknownMetadata, h.raw.unknownMetadata);
  assert.equal(after.revision, 18);
  assert.equal(receipt.tasks.length, 2);
  h.journal.fenced(receipt);
  assert.equal(await verifyScheduleFence(h.journal, h.options), true);
  const original = h.manifest.files.find(file => file.category === 'scheduler');
  assert.equal(sha256(readFileSync(h.journal.sourcePath(original))), original.sha256);
});

test('a changed or running selected record blocks the whole write before any disable intent', async t => {
  for (const patch of [{ nextRun: '2027-01-01T00:00:00Z' }, { status: 'running', runOwner: { attemptId: 'racing' } }]) {
    const h = await fixture(t);
    Object.assign(h.raw.tasks[1], patch);
    const bytes = JSON.stringify(h.raw);
    writeFileSync(h.file, bytes);
    await assert.rejects(fenceSchedules(h.journal, h.options), /changed|running|uncertain/);
    assert.equal(readFileSync(h.file, 'utf8'), bytes);
    assert.deepEqual(h.journal.record.intents, []);
  }
});

test('the compatible shared lock and active owner both block cutover', async t => {
  const h = await fixture(t), release = await lockfile.lock(h.file, { realpath: false, stale: 10000, update: 2000 });
  try {
    await assert.rejects(fenceSchedules(h.journal, h.options), /lock/i);
  } finally {
    await release();
  }
  const running = await fixture(t, { active: true });
  await assert.rejects(fenceSchedules(running.journal, running.options), /running|shutdown/);
  assert.deepEqual(JSON.parse(readFileSync(running.file, 'utf8')), running.raw);
});

test('archive drift and an out-of-protocol write after intents cannot pass compare-and-swap', async t => {
  const h = await fixture(t), source = h.manifest.files.find(file => file.category === 'scheduler');
  const original = readFileSync(h.file, 'utf8');
  writeFileSync(h.journal.sourcePath(source), JSON.stringify({ ...h.raw, unknownMetadata: ['tampered'] }));
  await assert.rejects(fenceSchedules(h.journal, h.options), /changed|archive/);
  assert.equal(readFileSync(h.file, 'utf8'), original);
  const concurrent = await fixture(t);
  await assert.rejects(fenceSchedules(concurrent.journal, {
    ...concurrent.options,
    failpoint: at => {
      if (at === 'scheduler-intents') writeFileSync(concurrent.file, JSON.stringify({ ...concurrent.raw, revision: 30 }));
    },
  }), /changed/);
  assert.equal(JSON.parse(readFileSync(concurrent.file, 'utf8')).tasks[0].enabled, true);
});

test('a crash after scheduler rename resumes from persisted intents without a second write', async t => {
  const h = await fixture(t);
  await assert.rejects(fenceSchedules(h.journal, { ...h.options, failpoint: at => { if (at === 'scheduler-written') throw Error('synthetic crash'); } }), /synthetic crash/);
  const bytes = readFileSync(h.file, 'utf8');
  assert.equal(h.journal.record.intents.length, 2);
  const receipt = await fenceSchedules(h.journal, h.options);
  assert.equal(readFileSync(h.file, 'utf8'), bytes);
  h.journal.fenced(receipt);
  const changed = JSON.parse(bytes);
  changed.tasks[0].enabled = true;
  writeFileSync(h.file, JSON.stringify(changed));
  await assert.rejects(verifyScheduleFence(h.journal, h.options), /changed|fenc/);
});
