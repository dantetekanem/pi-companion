import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertRuntimeAdmission } from './migration/admission.mjs';
import { sha256 } from './migration/inventory.mjs';

const json = path => JSON.parse(readFileSync(path, 'utf8'));
const identity = (origin, kind, id) => JSON.stringify([origin, kind, id]);
const estimate = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function localReports(root) {
  const path = join(root, 'runtime/imported-reports.json');
  if (!existsSync(path)) return [];
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 16777216) {
    throw Error('Local imported reports must be a private bounded regular file.');
  }
  const saved = json(path);
  if (saved.version !== 1 || !Array.isArray(saved.reports) || saved.reports.length > 10000) {
    throw Error('Invalid local imported report collection.');
  }
  const ids = new Set();
  for (const report of saved.reports) {
    if (!report || !['id', 'title', 'body', 'origin', 'path'].every(key => typeof report[key] === 'string')
      || !Number.isFinite(Date.parse(report.at)) || report.outcome !== 'imported'
      || ![undefined, 'read', 'unread', 'unknown'].includes(report.readState) || ids.has(report.id)) {
      throw Error('Invalid or duplicate local imported report.');
    }
    ids.add(report.id);
    if (report.readState === 'unknown') {
      delete report.readState;
      delete report.readAt;
    }
  }
  return saved.reports;
}

function visibleHistory(history, reports, limit) {
  reports.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id));
  history.reports = reports.slice(0, limit).map(report => ({
    ...report,
    title: report.title.slice(0, 512),
    body: report.body.slice(0, 32768),
    truncated: report.body.length > 32768,
  }));
  history.omittedReports = Math.max(0, reports.length - limit);
  return history;
}

/** Local historical evidence only. Never feeds archives to a model or changes read/accounting state. */
export function loadImportedHistory(requestedRoot, { limit = 200 } = {}) {
  if (!Number.isInteger(limit) || limit < 0 || limit > 10000) throw Error('History limit must be between 0 and 10000.');
  const root = assertRuntimeAdmission(requestedRoot);
  const history = {
    origins: [],
    archives: [],
    sessions: [],
    reports: [],
    omittedReports: 0,
    cost: {
      usd: 0,
      missingCostReceipts: 0,
      receipts: [],
      totalHistoricalSpend: null,
      coverage: 'partial historical estimates',
    },
  };
  const indexPath = join(root, 'imported/sessions/index.json');
  const reports = localReports(root);
  if (!existsSync(indexPath)) return visibleHistory(history, reports, limit);
  const record = json(join(dirname(dirname(root)), 'journal.json'));
  history.archives = record.manifest.files.map(entry => ({
    ...entry,
    archivePath: join(dirname(root), 'originals', sha256(entry.path)),
    authority: 'historical-evidence',
  }));
  history.sessions = json(indexPath).sessions.map(session => ({ ...session, path: join(root, session.path) }));
  for (const artifact of record.validation.artifacts.filter(item => item.path.startsWith('imported/states/'))) {
    const path = join(root, artifact.path);
    const { origin, source, legacy } = json(path);
    history.origins.push({ origin, path, source, authority: 'historical-evidence' });
    for (const item of legacy.items) {
      reports.push({
        id: identity(origin, 'report', item.id),
        sourceId: item.id,
        origin,
        path,
        title: item.title,
        body: item.body,
        at: item.savedAt,
        outcome: 'imported',
        provider: null,
        readState: item.readAt ? 'read' : 'unread',
        readAt: item.readAt ?? null,
        checks: item.checks,
      });
    }
    for (const question of legacy.experience?.questions ?? []) {
      const evidence = legacy.experience.evidence.find(item => item.id === question.id && item.kind === 'question');
      reports.push({
        id: identity(origin, 'question', question.id),
        sourceId: question.id,
        origin,
        path,
        title: `Question · ${question.status}`,
        body: question.text,
        at: question.at,
        outcome: 'imported',
        provider: evidence?.provider ?? null,
      });
    }
    for (const review of legacy.experience?.reviews ?? []) {
      const usd = estimate(review.cost) ? review.cost : null;
      history.cost.receipts.push({
        id: identity(origin, 'review', review.id),
        origin,
        sourceId: review.id,
        path,
        at: review.at,
        usd,
        binding: review.binding ?? null,
      });
      if (usd === null) history.cost.missingCostReceipts++;
      else history.cost.usd += usd;
    }
  }
  return visibleHistory(history, reports, limit);
}
