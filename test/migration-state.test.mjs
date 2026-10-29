import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inventoryLegacy, sha256 } from '../src/cli/migration/inventory.mjs';
import { MigrationJournal } from '../src/cli/migration/journal.mjs';
import { importStates } from '../src/cli/migration/state.mjs';

const at = '2026-01-01T00:00:00.000Z';
const state = () => ({
  version: 1,
  items: [{
    id: 'same',
    kind: 'report',
    final: true,
    title: 'Report',
    body: 'Body',
    checks: [{ source: 'test', outcome: 'no_change', detail: 'Checked' }],
    savedAt: at,
    readAt: at,
  }],
  paused: [],
  unknown: { nested: [1, null] },
});
const experience = () => ({
  version: 1,
  enabled: true,
  generation: 2,
  wake: { token: 'token', schedule: 'daily', schedulerId: 'external-task' },
  pendingWake: 'pending',
  evidence: [{ id: 'user', at, provider: 'pi', kind: 'user', text: 'Yes' }, { id: 'observation', at, provider: 'pi', kind: 'observation', text: 'Observed', refs: ['user'] }],
  questions: [{ id: 'question', text: 'Continue?', at, status: 'answered', answerIds: ['user'] }],
  lessons: [{ id: 'lesson', action: 'upsert', text: 'Learned', confidence: 'supported', evidenceIds: ['user'], at }, { id: 'lesson', action: 'remove', text: 'Retired', confidence: 'supported', evidenceIds: ['user'], at }],
  decisions: [{ id: 'decision', action: 'create', proposal: 'Do it', successSignal: 'Done', evidenceIds: ['observation'], appliedEvidenceIds: ['user'], at }],
  assessments: [{ taskId: 'external-task', signal: 'helpful', basis: 'explicit', reason: 'Asked', evidenceIds: ['user'], at }],
  reviews: [{
    id: 'review',
    day: '2026-01-01',
    at,
    status: 'completed',
    evidenceIds: ['user'],
    binding: { model: 'model', thinking: 'high' },
    cost: 0.1,
  }],
  extra: 'preserved',
});
async function fixture(t, values) {
  const root = mkdtempSync(join(tmpdir(), 'companion-state-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const directory = join(home, '.pi/agent/companion');
  mkdirSync(directory, { recursive: true });
  for (const [name, value] of Object.entries(values)) writeFileSync(join(directory, name), typeof value === 'string' ? value : JSON.stringify(value));
  const manifest = inventoryLegacy({ home });
  const journal = await MigrationJournal.open(join(root, 'destination'), manifest, { selection: { sessionId: 'synthetic', sessionFile: join(root, 'synthetic-session.jsonl') } });
  t.after(() => journal.close());
  await journal.stage();
  return { journal, manifest, load: artifact => JSON.parse(readFileSync(join(journal.dataRoot, artifact.path), 'utf8')) };
}
const name = id => `${sha256(id)}.json`;

test('imports every origin without collapsing IDs or altering optional and unknown fields', async t => {
  const first = { ...state(), experience: experience() };
  const second = { ...state(), stopping: [], started: false };
  first.experience.evidence.push(
    { id: 'delivery', at, provider: 'pi', kind: 'delivery', text: 'Delivered', taskId: 'task', runId: 'run' },
    { id: 'outcome', at, provider: 'pi', kind: 'outcome', text: 'Done', taskId: 'task', runId: 'run', refs: ['delivery'], outcome: 'completed' },
    { id: 'answer', at, provider: 'pi', kind: 'answer', text: JSON.stringify({ questionId: 'question', evidenceIds: ['user'] }), refs: ['user'] },
    { id: 'applied', at, provider: 'pi', kind: 'applied', text: JSON.stringify({ decisionId: 'decision', evidenceIds: ['user'] }), refs: ['user'] },
  );
  const { journal, manifest, load } = await fixture(t, { [name('one')]: first, [name('two')]: second, 'unknown.json': '{unknown raw' });
  const result = importStates(journal);
  assert.deepEqual(result.errors, []);
  assert.equal(result.origins.length, 2);
  assert.equal(result.artifacts.length, 2);
  for (const entry of manifest.files.filter(item => item.category === 'state')) {
    const imported = load(result.artifacts.find(item => item.origin === entry.origin));
    assert.equal(imported.origin, entry.origin);
    assert.deepEqual(imported.source, { ...entry, archivePath: journal.sourcePath(entry) });
    assert.deepEqual(imported.legacy, entry.path.endsWith(name('one')) ? first : second);
    assert.deepEqual(readFileSync(journal.sourcePath(entry)), Buffer.from(JSON.stringify(imported.legacy)));
  }
  assert.equal(readFileSync(journal.sourcePath(manifest.files.find(item => item.category === 'unknown')), 'utf8'), '{unknown raw');
  assert.deepEqual(importStates(journal), result);
});

test('reports all malformed JSON, unsupported versions and broken references without accepting them', async t => {
  const broken = { ...state(), experience: experience() };
  broken.experience.lessons[0].evidenceIds = ['absent'];
  const { journal } = await fixture(t, { [name('bad-json')]: 'PRIVATE malformed body', [name('wrong-version')]: { ...state(), version: 2 }, [name('broken')]: broken, [name('valid')]: state() });
  const result = importStates(journal);
  assert.equal(result.origins.length, 4);
  assert.equal(result.artifacts.length, 1);
  assert.deepEqual(new Set(result.errors.map(item => item.code)), new Set(['invalid_json', 'invalid_state', 'broken_reference']));
  assert.ok(result.errors.every(item => item.origin && item.source.path && item.problem));
  assert.doesNotMatch(JSON.stringify(result.errors), /PRIVATE/);
  assert.ok(result.errors.some(item => item.problem.includes('experience.lessons[0].evidenceIds[0]')));
  assert.equal(journal.verifyArchive(), true);
});

test('validates provider links, question answers, decisions, and review references in their own origin', async t => {
  const cases = [
    value => { value.evidence[1].provider = 'other'; },
    value => { value.questions[0].answerIds = ['missing']; },
    value => { value.decisions[0].appliedEvidenceIds = ['missing']; },
    value => { value.reviews[0].evidenceIds = ['missing']; },
    value => { value.evidence.push({ id: 'outcome', at, provider: 'pi', kind: 'outcome', text: 'Done', taskId: 'task', runId: 'missing-run', refs: [] }); },
    value => { value.questions[0].answerIds = ['observation']; },
    value => { value.evidence.push({ id: 'answer', at, provider: 'pi', kind: 'answer', text: JSON.stringify({ questionId: 'missing', evidenceIds: ['user'] }), refs: ['user'] }); },
    value => { value.evidence.push({ id: 'applied', at, provider: 'pi', kind: 'applied', text: JSON.stringify({ decisionId: 'missing', evidenceIds: ['user'] }), refs: ['user'] }); },
  ];
  const values = Object.fromEntries(cases.map((change, index) => {
    const value = experience();
    change(value);
    return [name(`case-${index}`), { ...state(), experience: value }];
  }));
  values[name('other-origin')] = { ...state(), experience: { ...experience(), evidence: [...experience().evidence, { id: 'missing', at, provider: 'pi', kind: 'user', text: 'Not in the right origin' }] } };
  const { journal } = await fixture(t, values);
  const result = importStates(journal);
  assert.equal(result.errors.length, cases.length);
  assert.equal(result.artifacts.length, 1);
});

test('keeps corrupt raw bytes and records exact repaired structured value provenance', async t => {
  const { journal, manifest, load } = await fixture(t, { [name('repair')]: '{broken' });
  const entry = manifest.files[0];
  const repaired = state();
  const provenance = { decisionId: 'repair-1', reason: 'Synthetic correction' };
  const result = importStates(journal, { overrides: [{ path: entry.path, sha256: entry.sha256, value: repaired, provenance }] });
  assert.deepEqual(result.errors, []);
  const imported = load(result.artifacts[0]);
  assert.deepEqual(imported.legacy, repaired);
  assert.deepEqual(imported.override, { provenance, sha256: sha256(JSON.stringify(repaired)) });
  assert.equal(readFileSync(journal.sourcePath(entry), 'utf8'), '{broken');
  assert.equal(journal.verifyArchive(), true);
});

test('rejects stale, unknown, duplicate or unprovenanced overrides explicitly', async t => {
  const { journal, manifest } = await fixture(t, { [name('repair')]: state() });
  const valid = { path: manifest.files[0].path, sha256: manifest.files[0].sha256, value: state(), provenance: { reason: 'Repair' } };
  for (const overrides of [[{ ...valid, sha256: 'stale' }], [{ ...valid, path: '/unknown' }], [valid, valid], [{ ...valid, provenance: undefined }]]) {
    const result = importStates(journal, { overrides });
    assert.ok(result.errors.some(item => item.code === 'invalid_override'));
    assert.deepEqual(result.artifacts, []);
  }
});

test('rejects repair inputs that JSON serialization would silently change', async t => {
  const { journal, manifest } = await fixture(t, { [name('repair')]: state() });
  const entry = manifest.files[0];
  for (const value of [{ ...state(), unknown: undefined }, { ...state(), unknown: NaN }]) {
    const result = importStates(journal, { overrides: [{ path: entry.path, sha256: entry.sha256, value, provenance: { reason: 'Repair' } }] });
    assert.equal(result.errors[0]?.code, 'invalid_override');
    assert.equal(result.artifacts.length, 0);
  }
});

test('refuses incomplete staging, archive changes, and invalid state structures', async t => {
  const { journal } = await fixture(t, { [name('bad-shape')]: { ...state(), stopping: null }, [name('bad-experience')]: { ...state(), experience: { ...experience(), version: 2 } } });
  assert.equal(importStates(journal).errors.length, 2);
  const entry = journal.record.manifest.files[0];
  writeFileSync(journal.sourcePath(entry), 'changed');
  assert.throws(() => importStates(journal), /changed|private/);
  const fake = { record: { phase: 'inventory' } };
  assert.throws(() => importStates(fake), /staged/);
});
