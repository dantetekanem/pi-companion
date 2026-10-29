import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageLedger } from '../src/cli/usage.mjs';
const epoch = '2026-10-26T00:00:00Z';
function ledger(t) {
  const root = mkdtempSync(join(tmpdir(), 'companion-usage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, usage: UsageLedger.open(root, epoch) };
}
const observation = (id, usd, values = {}) => ({
  id,
  harness: 'claude',
  sessionId: 'session-a',
  status: 'completed',
  freshSession: true,
  cost: { usd, cumulative: true, kind: 'estimate', sessionId: 'session-a' },
  ...values,
});

test('cumulative final receipts count only deltas and persist deduplication across restarts', t => {
  const { root, usage } = ledger(t);
  usage.record(observation('one', 1));
  usage.record(observation('one', 1));
  usage.record(observation('two', 1.5, { freshSession: false }));
  assert.equal(usage.snapshot().usd, 1.5);
  const restored = UsageLedger.open(root, epoch);
  restored.record(observation('two', 1.5, { freshSession: false }));
  assert.equal(restored.snapshot().usd, 1.5);
  assert.throws(() => restored.record(observation('one', 9)), /conflicting/);
  assert.throws(() => UsageLedger.open(root, '2026-10-27T00:00:00Z'), /epoch/);
});

test('adopted Pi history is excluded by its exact session baseline; a different session cannot borrow it', t => {
  const { usage } = ledger(t);
  usage.baseline('pi', 'main', 100);
  usage.record(observation('main1', 101, {
    harness: 'pi',
    sessionId: 'main',
    freshSession: false,
    cost: { usd: 101, cumulative: true, kind: 'estimate', sessionId: 'main' },
  }));
  usage.record(observation('other', 50, {
    harness: 'pi',
    sessionId: 'other',
    freshSession: false,
    cost: { usd: 50, cumulative: true, kind: 'estimate', sessionId: 'other' },
  }));
  assert.equal(usage.snapshot().usd, 1);
  assert.deepEqual(usage.snapshot().issues, { missing_session_baseline: 1 });
  assert.match(usage.snapshot().coverage, /1 missing session baseline/);
});

test('missing, interrupted, decreasing or mismatched observations stay visible, not zero-cost success', t => {
  const { usage } = ledger(t);
  usage.record(observation('good', 2));
  usage.record(observation('missing', 0, { cost: null, sessionId: null, status: 'interrupted' }));
  usage.record(observation('decrease', 1, { freshSession: false }));
  usage.record(observation('mismatch', 5, { cost: { usd: 5, cumulative: true, kind: 'estimate', sessionId: 'wrong' } }));
  assert.equal(usage.snapshot().usd, 2);
  assert.deepEqual(usage.snapshot().issues, { missing_or_mismatched_cost: 2, cumulative_cost_decreased: 1 });
  usage.record(observation('later', 3, { freshSession: false }));
  assert.equal(usage.snapshot().usd, 3);
  assert.deepEqual(usage.snapshot().issues, { missing_or_mismatched_cost: 2, cumulative_cost_decreased: 1 });
});

test('sync accounts main and fresh-job receipts once without counting main history or streaming usage again', t => {
  const { usage } = ledger(t);
  const state = {
    main: { sessionId: 'main', baseline: { usd: 10 } },
    runs: {
      chat: {
        id: 'chat',
        kind: 'main',
        harness: 'pi',
        sessionId: 'main',
        status: 'completed',
        finishedAt: epoch,
        result: { cost: { usd: 10.25, cumulative: true, kind: 'estimate', sessionId: 'main' } },
      },
      job: {
        id: 'job',
        kind: 'background',
        harness: 'claude',
        status: 'completed',
        finishedAt: epoch,
        result: {
          sessionId: 'session-a',
          freshSession: true,
          cost: { usd: 0.75, cumulative: true, kind: 'estimate', sessionId: 'session-a' },
        },
      },
      pending: { id: 'pending', kind: 'background', status: 'running' },
    },
  };
  usage.sync(state);
  usage.sync(state);
  assert.equal(usage.snapshot().usd, 1);
  assert.deepEqual(usage.snapshot().issues, {});
  assert.equal(usage.snapshot().pending, 1);
  assert.equal(usage.snapshot().initializedAt, epoch);
});

test('estimate reset persists without deleting receipts and counts only later cost', t => {
  const { root, usage } = ledger(t);
  usage.record(observation('before-reset', 1));
  const historical = JSON.parse(readFileSync(usage.file, 'utf8'));

  usage.resetEstimate();
  assert.equal(usage.snapshot().usd, 0);
  const saved = JSON.parse(readFileSync(usage.file, 'utf8'));
  assert.deepEqual(saved.segments, historical.segments);
  assert.deepEqual(saved.receipts, historical.receipts);

  const reopened = UsageLedger.open(root, epoch);
  assert.equal(reopened.snapshot().usd, 0);
  reopened.record(observation('after-reset', 1.25, { freshSession: false }));
  assert.equal(reopened.snapshot().usd, 0.25);
  assert.equal(Object.keys(JSON.parse(readFileSync(reopened.file, 'utf8')).receipts).length, 2);
});

test('completed final costs repair legacy incomplete coverage and remain idempotent', t => {
  const { root, usage } = ledger(t);
  const legacyReceipt = observation('not-run', 0.4, { status: 'incomplete' });
  usage.record(legacyReceipt);
  assert.equal(usage.snapshot().usd, 0.4);
  assert.deepEqual(usage.snapshot().issues, { missing_final_receipt: 1 });

  const legacyResult = {
    status: 'incomplete',
    outcome: 'not_run',
    sessionId: 'session-a',
    freshSession: true,
    cost: legacyReceipt.cost,
    text: 'No checks ran',
    checks: [{ source: 'fixture/source', outcome: 'not_run', detail: 'No check was run' }],
  };
  const historicalResult = {
    sessionId: 'session-b',
    cost: { usd: 0.6, cumulative: true, kind: 'estimate', sessionId: 'session-b' },
    text: 'Preserved historical report',
    status: 'incomplete',
    executionCompleted: true,
  };

  const savedBytes = readFileSync(usage.file, 'utf8');
  const restored = UsageLedger.open(root, epoch);
  assert.deepEqual(restored.snapshot().issues, { missing_final_receipt: 1 });
  assert.equal(readFileSync(usage.file, 'utf8'), savedBytes);
  const state = {
    runs: {
      legacy: {
        id: 'not-run',
        harness: 'claude',
        status: 'incomplete',
        finishedAt: epoch,
        result: legacyResult,
      },
      historical: {
        id: 'historical',
        harness: 'claude',
        status: historicalResult.status,
        finishedAt: epoch,
        result: { ...historicalResult, freshSession: true },
      },
    },
  };
  restored.sync(state);
  restored.sync(state);

  assert.equal(restored.snapshot().usd, 1);
  assert.deepEqual(restored.snapshot().issues, {});
  assert.throws(() => restored.record(observation('not-run', 0.5, { status: 'incomplete' })), /conflicting/);

  const missingResult = {
    status: 'completed',
    sessionId: 'session-c',
    text: '# Finished report',
  };
  const mismatchResult = {
    status: 'completed',
    sessionId: 'session-d',
    cost: { usd: 0.2, cumulative: true, kind: 'estimate', sessionId: 'other-session' },
    text: '# Finished report',
  };
  restored.sync({
    runs: {
      missing: {
        id: 'missing',
        harness: 'claude',
        status: 'completed',
        result: { ...missingResult, freshSession: true },
      },
      mismatch: {
        id: 'mismatch',
        harness: 'claude',
        status: 'completed',
        result: { ...mismatchResult, freshSession: true },
      },
    },
  });
  assert.equal(restored.snapshot().usd, 1);
  assert.deepEqual(restored.snapshot().issues, { missing_or_mismatched_cost: 2 });
});
