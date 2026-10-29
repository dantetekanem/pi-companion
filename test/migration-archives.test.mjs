import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inventoryLegacy } from '../src/cli/migration/inventory.mjs';
import { MigrationJournal } from '../src/cli/migration/journal.mjs';
import { importArchives } from '../src/cli/migration/archives.mjs';

test('registry, entire nested notes tree and feed keep their bytes, paths and original mode provenance in private history', async t => {
  const home = mkdtempSync(join(tmpdir(), 'companion-archives-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.companion-notes/nested/empty'), { recursive: true });
  const contents = {
    '.companion-schedules.md': '## Task\r\nUnstructured permissions\r\n',
    '.companion-reports-updates.md': '<!-- companion-publication:old -->\nOlder report\n',
    '.companion-notes/taste.md': 'Preferences\n',
    '.companion-notes/nested/notes.bin': Buffer.from([0, 1, 255, 10]),
  };
  for (const [path, bytes] of Object.entries(contents)) writeFileSync(join(home, path), bytes, { mode: 0o644 });
  const manifest = inventoryLegacy({ home });
  const journal = await MigrationJournal.open(join(home, 'v2'), manifest, { selection: { sessionId: 'saved', sessionFile: join(home, 'saved.jsonl') } });
  try {
    await journal.stage();
    const receipt = importArchives(journal);
    assert.equal(receipt.entries.length, 4);
    for (const entry of receipt.entries) {
      assert.deepEqual(readFileSync(join(journal.dataRoot, entry.path)), readFileSync(entry.source));
      assert.equal(statSync(join(journal.dataRoot, entry.path)).mode & 0o777, 0o600);
      assert.equal(entry.sourceMode, 0o644);
      assert.equal(Object.hasOwn(entry, 'readAt'), false);
      assert.equal(entry.authority, 'historical-evidence');
    }
    const empty = join(journal.dataRoot, 'imported/notes/nested/empty');
    assert.equal(statSync(empty).isDirectory(), true);
    assert.equal(statSync(empty).mode & 0o777, 0o700);
    assert.deepEqual(importArchives(journal), receipt);
    assert.equal(readFileSync(join(home, '.companion-reports-updates.md'), 'utf8'), contents['.companion-reports-updates.md']);
  } finally {
    await journal.close();
  }
});
