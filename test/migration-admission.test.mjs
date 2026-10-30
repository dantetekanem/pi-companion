import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inventoryLegacy } from '../src/cli/migration/inventory.mjs';
import { MigrationJournal } from '../src/cli/migration/journal.mjs';
import { installLegacyFence, collectShutdownReceipt } from '../src/cli/migration/fence.mjs';
import { validateOwnership } from '../src/cli/migration/ownership.mjs';
import { importSessions, pinSession } from '../src/cli/migration/adoption.mjs';
import { resolveDataRoot } from '../src/cli/migration/admission.mjs';
import { initialize, loadConfig } from '../src/cli/config.mjs';
import { CompanionRuntime } from '../src/cli/runtime.mjs';
import { openPiSession } from '../src/cli/pi-session.mjs';
import { UsageLedger } from '../src/cli/usage.mjs';

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'companion-admission-'));
  const home = join(directory, 'old');
  const root = join(directory, 'new');
  mkdirSync(join(home, '.pi/agent/companion'), { recursive: true });
  const sessionFile = join(home, 'selected.jsonl'), sessionId = '08347d55-30b3-4078-9ed5-f99c130a3b4f';
  const session = { type: 'session', version: 3, id: sessionId, cwd: home, timestamp: '2026-10-26T00:00:00Z' };
  const transcript = {
    type: 'message', id: 'transcript', parentId: null,
    timestamp: '2026-10-26T00:00:01Z',
    message: { role: 'user', content: [{ type: 'text', text: 'Original imported transcript' }], timestamp: 1792972801000 },
  };
  writeFileSync(sessionFile, [session, transcript].map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const selection = { sessionId, sessionFile }, manifest = inventoryLegacy({ home });
  const journal = await MigrationJournal.open(root, manifest, { selection });
  t.after(async () => {
    await journal.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await journal.stage();
  const controlRoot = join(directory, 'control'), migration = { id: journal.record.id, fingerprint: manifest.fingerprint, destination: root, owners: [selection] };
  await installLegacyFence(join(home, '.pi/agent/companion'), migration, { controlRoot });
  const offline = { confirmed: true, migrationId: migration.id, fingerprint: manifest.fingerprint, sessions: [selection], confirmedAt: new Date().toISOString() };
  const quiescence = await collectShutdownReceipt(join(home, '.pi/agent/companion'), migration, { controlRoot, offline });
  const ownership = validateOwnership({ manifest, selection, quiescence });
  const imported = importSessions(journal, { ownership, sessions: [pinSession(sessionFile)] });
  const config = { version: 2, initializedAt: new Date().toISOString(), main: { cwd: home, model: null, effort: 'medium' }, background: { harness: 'pi', model: null, effort: 'medium' }, concurrency: 2, timeoutMs: 300000 };
  const artifact = journal.writeData('config.json', Buffer.from(JSON.stringify(config)));
  journal.validate({ fingerprint: manifest.fingerprint, ownership, legacyFence: { controlRoot, migration }, artifacts: [...imported.artifacts, artifact], scheduleIds: [], validatedScheduleIds: [], errors: [] });
  return {
    root, journal, config, selection, controlRoot,
    complete() {
      journal.beginFence();
      journal.fenced({ validationId: journal.record.validation.id, shutdownReceipt: quiescence.receiptId, tasks: [] });
      journal.activate();
      journal.verifyActivation();
    },
  };
}

test('unfinished and merely committed migrations cannot initialize, connect or open a fresh runtime', async t => {
  const h = await fixture(t);
  for (const committed of [false, true]) {
    if (committed) {
      h.complete();
      const record = JSON.parse(readFileSync(h.journal.file, 'utf8'));
      record.phase = 'committed';
      writeFileSync(h.journal.file, JSON.stringify(record));
    }
    assert.throws(() => initialize(h.root), /migration|verif/i);
    assert.throws(() => loadConfig(h.root), /migration|verif/i);
    await assert.rejects(CompanionRuntime.open(h.root, h.config), /migration|verif/i);
    await assert.rejects(openPiSession({ root: h.journal.dataRoot, config: h.config }), /migration|verif/i);
    assert.equal(existsSync(join(h.root, 'config.json')), false);
    assert.equal(existsSync(join(h.root, 'runtime')), false);
  }
});

test('verified activation resolves one data root, allows working edits and rejects conflicting pointers or removed fences', async t => {
  const h = await fixture(t);
  h.complete();
  assert.equal(resolveDataRoot(h.root), h.journal.dataRoot);
  assert.equal(resolveDataRoot(h.journal.dataRoot), h.journal.dataRoot);
  assert.deepEqual(loadConfig(h.root), h.config);
  const edited = { ...h.config, concurrency: 1 };
  writeFileSync(join(h.journal.dataRoot, 'config.json'), JSON.stringify(edited));
  assert.deepEqual(initialize(h.root), edited);
  const pointer = readFileSync(join(h.root, 'active.json'));
  writeFileSync(join(h.root, 'active.json'), JSON.stringify({ version: 2, directory: '../../escape' }));
  assert.throws(() => resolveDataRoot(h.root), /activation|identity|pointer/);
  writeFileSync(join(h.root, 'active.json'), pointer);
  rmSync(join(h.controlRoot, 'fence.json'));
  assert.throws(() => resolveDataRoot(h.root), /fence/i);
});

test('adopted identity is checked before provider creation; missing or changed main never becomes a fresh session', async t => {
  const h = await fixture(t);
  h.complete();
  const main = join(h.journal.dataRoot, 'sessions/main.jsonl'), original = readFileSync(main);
  let calls = 0;
  const createSession = async () => {
    calls++;
    throw Error('Provider creation must not run');
  };
  rmSync(main);
  await assert.rejects(openPiSession({ root: h.root, config: h.config }, { createSession }), /missing|replacement/);
  assert.equal(existsSync(main), false);
  writeFileSync(main, original.toString().replace(h.selection.sessionId, 'different'));
  await assert.rejects(openPiSession({ root: h.root, config: h.config }, { createSession }), /identity/);
  assert.equal(calls, 0);
});

test('runtime uses the adopted Pi identity and captures its historical cost as baseline, not new spend', async t => {
  const h = await fixture(t);
  h.complete();
  const runtime = await CompanionRuntime.open(h.root, h.config, {
    createMain: options => openPiSession(options, {
      agentDir: join(h.root, 'pi-agent'),
      createSession: async ({ sessionManager }) => ({
        session: {
          sessionId: sessionManager.getSessionId(),
          sessionFile: sessionManager.getSessionFile(),
          thinkingLevel: 'medium',
          messages: [],
          getSessionStats() { return { sessionId: this.sessionId, cost: 17.25 }; },
          subscribe() { return () => {}; },
          abort: async () => {},
          async bindExtensions() {},
          dispose() {},
        },
      }),
    }),
  });
  const transcriptPath = join(h.journal.dataRoot, 'sessions/main.jsonl');
  const index = JSON.parse(readFileSync(join(h.journal.dataRoot, 'imported/sessions/index.json'), 'utf8'));
  const archivePath = join(h.journal.dataRoot, index.sessions[0].path);
  const transcript = readFileSync(transcriptPath);
  const archive = readFileSync(archivePath);
  const usage = UsageLedger.open(h.journal.dataRoot, h.config.initializedAt);
  let reset;
  try {
    await runtime.connect();
    const state = await runtime.state();
    assert.equal(runtime.directory, h.journal.dataRoot);
    assert.equal(state.main.sessionId, h.selection.sessionId);
    assert.equal(state.main.baseline.usd, 17.25);
    assert.deepEqual(state.runs, {});
    assert.deepEqual(transcript, archive);
    assert.match(transcript.toString(), /Original imported transcript/);

    reset = await runtime.reset();
    const afterReset = await runtime.state();
    assert.notEqual(reset.sessionId, h.selection.sessionId);
    assert.notEqual(reset.sessionFile, transcriptPath);
    assert.equal(afterReset.main.sessionId, reset.sessionId);
    assert.equal(afterReset.main.sessionFile, reset.sessionFile);
    assert.equal(afterReset.main.baseline.usd, 17.25);
    assert.equal(afterReset.sessionBaselines[h.selection.sessionId].baseline.usd, 17.25);
    assert.deepEqual(readFileSync(transcriptPath), transcript);
    assert.deepEqual(readFileSync(archivePath), archive);
    assert.equal(usage.sync(afterReset).usd, 0);
  } finally {
    await runtime.close();
  }
  const reopened = await CompanionRuntime.open(h.root, h.config, { createMain: runtime.createMain });
  try {
    await reopened.connect();
    const state = await reopened.state();
    assert.equal(reopened.main.sessionId, reset.sessionId);
    assert.equal(state.main.sessionFile, reset.sessionFile);
    assert.equal(state.main.baseline.usd, 17.25);
    assert.equal(state.sessionBaselines[h.selection.sessionId].baseline.usd, 17.25);
    assert.deepEqual(readFileSync(transcriptPath), transcript);
    assert.deepEqual(readFileSync(archivePath), archive);
    assert.equal(usage.sync(state).usd, 0);
  } finally {
    await reopened.close();
  }
  const history = join(h.journal.dataRoot, 'imported/sessions/index.json');
  writeFileSync(history, '{}');
  await assert.rejects(CompanionRuntime.open(h.root, h.config), /history|changed|immutable/);
});
