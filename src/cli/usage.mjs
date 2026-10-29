import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicJson } from './config.mjs';

const validCost = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const keyFor = (harness, sessionId) => createHash('sha256').update(JSON.stringify([harness, sessionId])).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const totalCost = segments => Object.values(segments).reduce((sum, segment) => sum + segment.usd, 0);

function hasLegacyNotRunReport(result) {
  return result?.status === 'incomplete'
    && result.outcome === 'not_run'
    && typeof result.text === 'string'
    && Array.isArray(result.checks)
    && result.checks.length > 0
    && result.checks.length <= 30
    && result.checks.every(check => check
      && typeof check.source === 'string'
      && check.source.trim()
      && check.outcome === 'not_run'
      && typeof check.detail === 'string'
      && check.detail.trim())
    && result.error === undefined
    && result.rawText === undefined;
}

function setBaseline(data, harness, sessionId, usd) {
  if (!['pi', 'claude'].includes(harness) || typeof sessionId !== 'string' || !sessionId) throw Error('Invalid accounting identity.');
  const key = keyFor(harness, sessionId);
  const baseline = validCost(usd) ? usd : null;
  if (data.segments[key]) {
    if (data.segments[key].baseline !== baseline) throw Error('A session baseline cannot change after accounting begins.');
    return;
  }
  data.segments[key] = { harness, sessionId, baseline, last: baseline, usd: 0 };
}

function addReceipt(data, receipt, executionCompleted = false) {
  if (typeof receipt.id !== 'string' || !receipt.id) throw Error('A cost receipt needs a stable ID.');
  const key = keyFor('receipt', receipt.id);
  const signature = JSON.stringify(receipt);
  const existing = data.receipts[key];
  if (existing) {
    if (existing.signature !== signature) throw Error('A conflicting cost receipt cannot replace a saved observation.');
    if (existing.reason === 'incomplete_coverage'
      && receipt.status === 'incomplete'
      && executionCompleted) {
      existing.reason = null;
    }
    return;
  }
  const { harness, sessionId, cost } = receipt;
  let reason = null;
  let delta = 0;
  const segmentKey = keyFor(harness, sessionId);
  if (!['pi', 'claude'].includes(harness)
    || typeof sessionId !== 'string'
    || !sessionId
    || !validCost(cost?.usd)
    || !cost.cumulative
    || cost.kind !== 'estimate'
    || cost.sessionId !== sessionId) {
    reason = 'missing_or_mismatched_cost';
  } else {
    if (!data.segments[segmentKey]) setBaseline(data, harness, sessionId, receipt.freshSession === true ? 0 : null);
    const segment = data.segments[segmentKey];
    if (segment.last === null) reason = 'unknown_session_baseline';
    else if (cost.usd < segment.last) reason = 'cumulative_cost_decreased';
    else {
      delta = cost.usd - segment.last;
      segment.usd += delta;
      segment.last = cost.usd;
    }
  }
  if (receipt.status === 'interrupted'
    || (receipt.status === 'incomplete' && !executionCompleted)) reason ??= 'incomplete_coverage';
  data.receipts[key] = { id: receipt.id, signature, delta, reason };
}

/** Single-writer projection of persisted final receipts, never of streaming token events. */
export class UsageLedger {
  static open(root, initializedAt) {
    if (!Number.isFinite(Date.parse(initializedAt))) throw Error('Invalid accounting epoch.');
    const file = join(root, 'runtime', 'usage.json');
    let data = { version: 1, initializedAt, segments: {}, receipts: {}, pending: 0 };
    if (existsSync(file)) {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.size > 16777216) throw Error('Usage ledger must be a bounded regular file.');
      data = JSON.parse(readFileSync(file, 'utf8'));
      if (data.version !== 1 || !data.segments || !data.receipts || data.initializedAt !== initializedAt) throw Error('Usage ledger schema or initialization epoch changed.');
    }
    const ledger = new UsageLedger();
    ledger.file = file;
    ledger.data = data;
    return ledger;
  }

  commit(update) {
    const next = clone(this.data);
    update(next);
    if (JSON.stringify(next) === JSON.stringify(this.data)) return;
    atomicJson(this.file, next);
    this.data = next;
  }

  baseline(harness, sessionId, usd) {
    this.commit(data => setBaseline(data, harness, sessionId, usd));
  }

  resetEstimate() {
    this.commit(data => { data.estimateBaselineUsd = totalCost(data.segments); });
    return this.snapshot();
  }

  record(receipt) {
    this.commit(data => addReceipt(data, receipt));
  }

  sync(state) {
    this.commit(data => {
      if (state.main) setBaseline(data, 'pi', state.main.sessionId, state.main.baseline?.usd);
      for (const [sessionId, observation] of Object.entries(state.sessionBaselines ?? {})) {
        setBaseline(data, 'pi', sessionId, observation.baseline?.usd);
      }
      const runs = Object.values(state.runs).sort((a, b) =>
        (a.finishedAt ?? '').localeCompare(b.finishedAt ?? '') || a.id.localeCompare(b.id));
      data.pending = runs.filter(run => run.status === 'running').length;
      for (const run of runs) {
        if (run.status === 'running' || run.imported || run.result?.noModel === true) continue;
        const cost = run.result?.cost ?? run.cost ?? null;
        const executionCompleted = run.result?.executionCompleted === true
          || hasLegacyNotRunReport(run.result);
        addReceipt(data, {
          id: run.id,
          harness: run.harness,
          sessionId: run.result?.sessionId ?? run.sessionId ?? cost?.sessionId ?? null,
          status: run.status,
          freshSession: run.result?.freshSession === true,
          cost,
        }, executionCompleted);
      }
    });
    return this.snapshot();
  }

  snapshot() {
    const issues = {};
    for (const receipt of Object.values(this.data.receipts)) {
      if (!receipt.reason) continue;
      const reason = receipt.reason === 'unknown_session_baseline' ? 'missing_session_baseline'
        : receipt.reason === 'incomplete_coverage' ? 'missing_final_receipt' : receipt.reason;
      issues[reason] = (issues[reason] ?? 0) + 1;
    }
    const coverage = Object.entries(issues).map(([reason, count]) => `${count} ${reason.replaceAll('_', ' ')}`);
    return {
      usd: Math.max(0, totalCost(this.data.segments) - (this.data.estimateBaselineUsd ?? 0)),
      initializedAt: this.data.initializedAt,
      issues,
      pending: this.data.pending,
      kind: 'estimate',
      coverage: `${coverage.join(', ') || 'recorded receipts'}${this.data.pending ? `, ${this.data.pending} pending` : ''}; not an invoice or subscription bill`,
    };
  }
}
