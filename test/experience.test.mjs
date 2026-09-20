import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = process.env.PI_PACKAGE_ROOT || resolve(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')), '../..');
const require = createRequire(join(root, 'package.json'));
const { createJiti } = require('jiti');
const host = createJiti(join(root, 'package.json'));
const alias = Object.fromEntries(['typebox', 'typebox/value'].map(name => [name, fileURLToPath(host.esmResolve(name))]));
const { ExperienceStore, recordEvidence, record, curate, view } = await createJiti(import.meta.url, { alias }).import('../src/experience.ts');
const at = '2026-09-19T12:00:00.000Z';
const reflection = patch => ({ assessments: [], lessons: [], decisions: [], answers: [], ...patch });
const evidence = (id, kind, text, extra = {}) => ({ id, kind, text, provider: 'test', ...extra });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'companion-experience-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new ExperienceStore(dir, 'owner');
  store.update(state => { state.enabled = true; });
  return { dir, store, reports: join(dir, 'updates.md') };
}

test('experience survives reload and duplicate evidence cannot strengthen or rewrite it', t => {
  const { dir, store } = fixture(t);
  const item = evidence('user-1', 'user', 'Friday afternoons are better.');
  store.update(state => recordEvidence(state, item, at));
  store.update(state => recordEvidence(state, item, '2026-09-20T00:00:00.000Z'));
  assert.equal(new ExperienceStore(dir, 'owner').load().evidence.length, 1);
  assert.equal(store.load().evidence[0].at, at);
  assert.throws(() => store.update(state => recordEvidence(state, { ...item, text: 'Changed' }, at)), /conflict/i);
  assert.equal(new ExperienceStore(dir, 'other').load().evidence.length, 0);
});

test('questions publish once and remain pending until a naturally recorded answer is linked', t => {
  const { store, reports } = fixture(t);
  const question = { kind: 'question', id: 'weekly-timing', text: 'When would a weekly review be useful?', evidenceIds: [] };
  store.update(state => record(state, question, reports, 'test', at));
  store.update(state => record(state, question, reports, 'test', at));
  assert.equal(readFileSync(reports, 'utf8').match(/When would/g).length, 1);
  assert.equal(view(store.load()).questions[0].status, 'open');
  store.update(state => recordEvidence(state, evidence('reply', 'user', 'Friday afternoon, after I wrap up.'), at));
  store.update(state => record(state, { kind: 'answer', id: 'answer-1', questionId: 'weekly-timing', evidenceIds: ['reply'] }, reports, 'test', at));
  assert.equal(view(store.load()).questions[0].status, 'answered');
  assert.deepEqual(view(store.load()).questions[0].answerIds, ['reply']);
  assert.equal(readFileSync(reports, 'utf8').match(/When would/g).length, 1);
});

test('publication rejects ID conflicts before writing and separates sessions in the shared feed', t => {
  const { store, reports, dir } = fixture(t);
  store.update(state => recordEvidence(state, evidence('same', 'observation', 'Existing observation.'), at));
  const question = { kind: 'question', id: 'same', text: 'A question?', evidenceIds: [] };
  assert.throws(() => store.update(state => record(state, question, reports, 'test', at, 'owner')), /conflict/i);
  assert.equal(existsSync(reports), false);
  const other = new ExperienceStore(dir, 'other');
  other.update(state => { state.enabled = true; record(state, question, reports, 'test', at, 'other'); });
  store.update(state => record(state, { ...question, id: 'shared' }, reports, 'test', at, 'owner'));
  other.update(state => record(state, { ...question, id: 'shared' }, reports, 'test', at, 'other'));
  assert.equal(readFileSync(reports, 'utf8').match(/A question/g).length, 3);
});

test('an uncertain append cannot be retried with different text under the same publication ID', t => {
  const { store, reports } = fixture(t);
  const question = { kind: 'question', id: 'uncertain', text: 'Original question?', evidenceIds: [] };
  assert.throws(() => store.update(state => { record(state, question, reports, 'test', at); throw Error('Save failed'); }), /Save failed/);
  assert.throws(() => store.update(state => record(state, { ...question, text: 'Different question?' }, reports, 'test', at)), /conflict/i);
  store.update(state => record(state, question, reports, 'test', at));
  assert.equal(readFileSync(reports, 'utf8').match(/Original question/g).length, 1);
  assert.equal(store.load().questions[0].text, question.text);
});

test('reports publish once against their own delivery without claiming the user read them', t => {
  const { store, reports } = fixture(t);
  const publication = { kind: 'publication', id: 'report-1', taskId: 'task_reading', runId: 'run-1', text: 'A useful finding.', evidenceIds: [] };
  assert.throws(() => store.update(state => record(state, publication, reports, 'test', at)), /delivery/i);
  store.update(state => recordEvidence(state, evidence('run-1', 'delivery', 'Delivered.', { taskId: 'task_reading', runId: 'run-1' }), at));
  store.update(state => record(state, publication, reports, 'test', at));
  store.update(state => record(state, publication, reports, 'test', at));
  assert.equal(readFileSync(reports, 'utf8').match(/A useful finding/g).length, 1);
  assert.equal(store.load().evidence.at(-1).kind, 'publication');
  assert.equal(store.load().assessments.length, 0);
});

test('agent observations cannot masquerade as user answers', t => {
  const { store, reports } = fixture(t);
  store.update(state => record(state, { kind: 'question', id: 'timing', text: 'Morning or afternoon?', evidenceIds: [] }, reports, 'test', at));
  store.update(state => recordEvidence(state, evidence('guess', 'observation', 'Probably mornings.'), at));
  assert.throws(() => store.update(state => record(state, { kind: 'answer', id: 'fake', questionId: 'timing', evidenceIds: ['guess'] }, reports, 'test', at)), /user/i);
  assert.equal(view(store.load()).questions[0].status, 'open');
});

test('delivery and silence remain unknown rather than becoming positive or negative reinforcement', t => {
  const { store } = fixture(t);
  store.update(state => recordEvidence(state, evidence('delivery', 'delivery', 'Report delivered.', { taskId: 'task_reading', runId: 'run-1' }), at));
  const assessment = { taskId: 'task_reading', signal: 'no_observed_response', basis: 'observed', reason: 'No response was captured.', evidenceIds: ['delivery'] };
  store.update(state => curate(state, reflection({ assessments: [assessment] }), ['delivery'], at));
  assert.equal(store.load().assessments[0].signal, 'no_observed_response');
  assert.throws(() => store.update(state => curate(state, reflection({ assessments: [{ ...assessment, signal: 'helpful', basis: 'explicit' }] }), ['delivery'], at)), /user|feedback/i);
  assert.throws(() => store.update(state => curate(state, reflection({ assessments: [{ ...assessment, signal: 'dismissed', basis: 'inferred' }] }), ['delivery'], at)), /feedback|outcome/i);
});

test('curation is evidence-grounded and incremental, with prior lesson revisions retained', t => {
  const { store } = fixture(t);
  store.update(state => recordEvidence(state, evidence('reply', 'user', 'Keep it short, and use Friday afternoons.'), at));
  const lesson = (id, text, action = 'upsert') => ({ id, text, action, confidence: 'supported', evidenceIds: ['reply'] });
  store.update(state => curate(state, reflection({ lessons: [lesson('length', 'Prefer short reports.'), lesson('timing', 'Prefer Friday afternoon.')] }), ['reply'], at));
  store.update(state => curate(state, reflection({ lessons: [lesson('timing', 'Only weekly reviews belong on Friday afternoon.')] }), ['reply'], at));
  assert.equal(store.load().lessons.length, 3);
  assert.deepEqual(view(store.load()).lessons.map(item => item.id).sort(), ['length', 'timing']);
  assert.match(view(store.load()).lessons.find(item => item.id === 'timing').text, /Only weekly/);
  store.update(state => curate(state, reflection({ lessons: [lesson('length', 'Context did not establish a universal length preference.', 'remove')] }), ['reply'], at));
  assert.deepEqual(view(store.load()).lessons.map(item => item.id), ['timing']);
  assert.throws(() => store.update(state => curate(state, reflection({ lessons: [lesson('unsupported', 'Invented')] }), [], at)), /visible|evidence/i);
});

test('a decision is applied only against a later scheduler receipt for the matching task', t => {
  const { store, reports } = fixture(t);
  store.update(state => recordEvidence(state, evidence('reply', 'user', 'Stop the reading reminder.'), at));
  store.update(state => curate(state, reflection({ decisions: [{ id: 'retire-reading', action: 'retire', taskId: 'task_reading', proposal: 'Disable the reading reminder.', successSignal: 'No further reminders.', evidenceIds: ['reply'] }] }), ['reply'], at));
  assert.throws(() => store.update(state => record(state, { kind: 'applied', id: 'claim', decisionId: 'retire-reading', evidenceIds: ['reply'] }, reports, 'test', at)), /scheduler/i);
  store.update(state => recordEvidence(state, evidence('disabled', 'schedule', 'Disabled.', { taskId: 'task_reading' }), '2026-09-19T12:01:00.000Z'));
  store.update(state => record(state, { kind: 'applied', id: 'applied-1', decisionId: 'retire-reading', evidenceIds: ['disabled'] }, reports, 'test', '2026-09-19T12:02:00.000Z'));
  assert.equal(view(store.load()).decisions.length, 0);
  assert.deepEqual(store.load().decisions[0].appliedEvidenceIds, ['disabled']);
});
