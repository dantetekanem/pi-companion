import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inventoryLegacy, sha256 } from '../src/cli/migration/inventory.mjs';
import { validateOwnership } from '../src/cli/migration/ownership.mjs';
const id = 'b6502857-3ca4-4a30-a305-c6ae2b2d65da';
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'companion-owner-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.pi/agent/companion'), { recursive: true });
  const sessionFile = join(home, 'selected.jsonl');
  writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3, id, cwd: home, timestamp: '2026-10-26T00:00:00Z' }) + '\n');
  writeFileSync(join(home, `.pi/agent/companion/${sha256(id)}.json`), JSON.stringify({ version: 1, items: [], paused: [] }));
  return { home, sessionFile, selection: { sessionFile, sessionId: id } };
}
const stopped = manifest => ({
  kind: 'host-shutdown',
  fingerprint: manifest.fingerprint,
  receiptId: 'shutdown-1',
  observedAt: '2026-10-26T12:00:00Z',
  sessions: [{ sessionId: id, state: 'stopped' }],
});

test('explicit saved selection maps its origin without treating stale owner or pane hints as authority', t => {
  const { home, selection } = fixture(t);
  writeFileSync(join(home, '.pi/agent/companion/owner.json'), JSON.stringify({ version: 1, sessionId: 'old-owner' }));
  const manifest = inventoryLegacy({ home, references: [{ kind: 'pi-session', path: selection.sessionFile }, { kind: 'location', path: join(home, 'pane.json') }] });
  const proof = stopped(manifest);
  proof.sessions.push({ sessionId: 'old-owner', state: 'stopped' });
  const result = validateOwnership({ manifest, selection, quiescence: proof });
  assert.equal(result.main.sessionId, id);
  assert.equal(result.main.origin, `session:${sha256(id)}`);
  assert.equal(result.historicalClaim.sessionId, 'old-owner');
  assert.equal(result.references.length, 2);
  assert.ok(result.warnings.includes('historical_owner_differs'));
  assert.doesNotMatch(JSON.stringify(result), /"messages"|"content"/);
});

test('missing, active or differently scoped shutdown evidence never authorizes adoption', t => {
  const { home, selection } = fixture(t);
  const manifest = inventoryLegacy({ home });
  assert.throws(() => validateOwnership({ manifest, selection }), /quiescen|shutdown/);
  assert.throws(() => validateOwnership({ manifest, selection, quiescence: { ...stopped(manifest), fingerprint: 'other' } }), /scope|fingerprint/);
  assert.throws(() => validateOwnership({ manifest, selection, quiescence: { ...stopped(manifest), sessions: [{ sessionId: id, state: 'running' }] } }), /active|stopped/);
  assert.throws(() => validateOwnership({ manifest, selection: { ...selection, sessionId: 'another' }, quiescence: stopped(manifest) }), /identity/);
});

test('every origin needs a stopped owner, including a second saved conversation not selected as main', t => {
  const { home, selection } = fixture(t);
  const other = 'd4d6b65f-6c57-4fea-b57d-2dfce14040ca';
  writeFileSync(join(home, `.pi/agent/companion/${sha256(other)}.json`), '{"version":1,"items":[],"paused":[]}');
  const manifest = inventoryLegacy({ home });
  assert.throws(() => validateOwnership({ manifest, selection, quiescence: stopped(manifest) }), /Unmapped/);
  const proof = stopped(manifest);
  proof.sessions.push({ sessionId: other, state: 'stopped' });
  const result = validateOwnership({ manifest, selection, quiescence: proof });
  assert.deepEqual(result.owners, [id, other]);
  assert.equal(result.main.sessionId, id);
});

test('optional lifecycle must be supplied from the pinned archive and cannot contain uncertain control work', t => {
  const { home, selection } = fixture(t);
  mkdirSync(join(home, '.pi/agent/companion/durable'));
  writeFileSync(join(home, '.pi/agent/companion/durable/companion.sqlite'), 'synthetic checkpoint bytes');
  const manifest = inventoryLegacy({ home });
  const checkpoint = {
    sha256: manifest.files.find(file => file.category === 'durable').sha256,
    lifecycle: { owner: selection, active: false, setup: 'ready', taskId: null, action: null },
    controlStatus: 'terminal',
  };
  assert.throws(() => validateOwnership({ manifest, selection, quiescence: stopped(manifest) }), /checkpoint/);
  assert.throws(() => validateOwnership({ manifest, selection, quiescence: stopped(manifest), checkpoint: { ...checkpoint, controlStatus: 'running' } }), /uncertain|control/);
  assert.throws(() => validateOwnership({ manifest, selection, quiescence: stopped(manifest), checkpoint: { ...checkpoint, lifecycle: { ...checkpoint.lifecycle, setup: 'requested' } } }), /uncertain|setup/);
  assert.equal(validateOwnership({ manifest, selection, quiescence: stopped(manifest), checkpoint }).main.sessionId, id);
});
