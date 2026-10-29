import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrationFixture } from './helpers/migration.mjs';
import { runUpgrade } from '../src/cli/migration/cutover.mjs';
import { loadImportedHistory } from '../src/cli/history.mjs';
import { UsageLedger } from '../src/cli/usage.mjs';
import { createDashboard } from '../src/cli/ui.mjs';
import { main } from '../src/cli/main.mjs';

const at = '2026-10-25T00:00:00Z';
const report = {
  id: 'same',
  kind: 'report',
  final: true,
  title: 'Saved report',
  body: 'Retained result',
  savedAt: at,
  checks: [{ source: 'Local fixture', outcome: 'findings', detail: 'Verified in the original run.' }],
};
async function fixture(t) {
  const h = await migrationFixture(t, {
    secondState: { version: 1, items: [{ ...report, readAt: at }], paused: [] },
    mutateState: state => {
      state.items.push(report);
      state.experience.evidence.push({ id: 'q', at, provider: 'original-provider', kind: 'question', text: 'A preserved question.' });
      state.experience.questions.push({ id: 'q', text: 'A preserved question.', at, status: 'open', answerIds: [] });
      state.experience.reviews.push({
        id: 'review',
        at,
        day: '2026-10-25',
        status: 'completed',
        binding: { model: 'original-provider/model', thinking: 'high' },
        evidenceIds: [],
        cost: 1.25,
      }, {
        id: 'unknown', at, day: '2026-10-24', status: 'failed', evidenceIds: [],
      });
    },
  });
  await runUpgrade(h.journal, h.options);
  return h;
}

test('all origins and archives remain reachable; report identities, real read state and provider provenance stay distinct', async t => {
  const h = await fixture(t), history = loadImportedHistory(h.root);
  assert.equal(history.origins.length, 2);
  assert.equal(history.archives.length, h.manifest.files.length);
  assert.equal(history.sessions.length, 2);
  for (const entry of history.archives) assert.equal(readFileSync(entry.archivePath).length, entry.size);
  const reports = history.reports.filter(item => item.sourceId === 'same');
  assert.equal(reports.length, 2);
  assert.notEqual(reports[0].id, reports[1].id);
  assert.deepEqual(reports.map(item => item.readState).sort(), ['read', 'unread']);
  assert.ok(reports.every(item => item.provider === null));
  const question = history.reports.find(item => item.sourceId === 'q');
  assert.equal(question.provider, 'original-provider');
  assert.equal(question.readState, undefined);
  const localPath = join(h.journal.dataRoot, 'runtime/imported-reports.json');
  const legacy = { ...question, id: 'saved-question', readState: 'unknown', readAt: null };
  mkdirSync(join(h.journal.dataRoot, 'runtime'), { recursive: true, mode: 0o700 });
  writeFileSync(localPath, JSON.stringify({ version: 1, reports: [legacy] }), { mode: 0o600 });
  const bytes = readFileSync(localPath, 'utf8');
  const restored = loadImportedHistory(h.root).reports.find(item => item.id === legacy.id);
  assert.equal(restored.readState, undefined);
  assert.equal(restored.provider, 'original-provider');
  assert.equal(readFileSync(localPath, 'utf8'), bytes);
  const limited = loadImportedHistory(h.root, { limit: 1 });
  assert.equal(limited.reports.length, 1);
  assert.equal(limited.omittedReports, history.reports.length);
  assert.equal(limited.origins.length, 2);
  assert.equal(limited.archives.length, history.archives.length);
});

test('partial historical estimates stay separate from v2 spend and reading history makes no accounting writes', async t => {
  const h = await fixture(t), history = loadImportedHistory(h.root);
  assert.equal(history.cost.usd, 1.25);
  assert.equal(history.cost.missingCostReceipts, 1);
  assert.equal(history.cost.totalHistoricalSpend, null);
  const ledger = UsageLedger.open(h.journal.dataRoot, h.journal.record.createdAt);
  assert.equal(ledger.snapshot().usd, 0);
  const before = readFileSync(h.journal.file, 'utf8');
  loadImportedHistory(h.root);
  assert.equal(readFileSync(h.journal.file, 'utf8'), before);
  assert.equal(ledger.snapshot().usd, 0);
  const rendered = createDashboard({ reports: history.reports, history, config: h.options.config, usage: ledger.snapshot() });
  rendered.input('\x1b[C');
  rendered.input('\r');
  assert.equal(rendered.state().focus, 'detail');
  assert.ok(rendered.render(120, 40).join('').replace(/\s/g, '').includes(history.reports[0].path));
});

test('the finite history command returns local paths and estimates without starting a provider', async t => {
  const h = await fixture(t);
  const chunks = [];
  assert.equal(await main(['history', '--home', h.root], { write: value => chunks.push(value) }), 0);
  const history = JSON.parse(chunks.join(''));
  assert.equal(history.origins.length, 2);
  assert.equal(history.cost.totalHistoricalSpend, null);
  const statePath = history.origins[0].path;
  writeFileSync(statePath, '{}');
  assert.throws(() => loadImportedHistory(h.root), /changed|history/);
});
