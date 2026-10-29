import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicJson, loadConfig } from './config.mjs';
import { resolveDataRoot } from './migration/admission.mjs';
import { loadSchedules } from './schedules.mjs';
import { loadImportedHistory } from './history.mjs';
import { UsageLedger } from './usage.mjs';
import { readReport } from './reports.mjs';

const presentationPath = requestedRoot => join(resolveDataRoot(requestedRoot), 'runtime', 'presentation.json');
const normalizeMessageIds = value => {
  if (!Array.isArray(value) || value.length > 100000
    || value.some(id => typeof id !== 'string' || !id || id.length > 256)) {
    throw Error('Saved presentation state has invalid message IDs.');
  }
  return [...new Set(value)];
};

export function readPresentationState(requestedRoot) {
  const file = presentationPath(requestedRoot);
  if (!existsSync(file)) return { version: 1, hiddenMessageIds: [] };
  const stat = lstatSync(file);
  if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 1048576) {
    throw Error('Saved presentation state must be a private bounded regular file.');
  }
  let saved;
  try {
    saved = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw Error('Invalid saved presentation state.');
  }
  if (saved?.version !== 1) throw Error('Unsupported saved presentation state.');
  return { version: 1, hiddenMessageIds: normalizeMessageIds(saved.hiddenMessageIds) };
}

export function savePresentationState(requestedRoot, messageIds) {
  if (!Array.isArray(messageIds)) throw Error('Presentation clear state requires message IDs.');
  const root = resolveDataRoot(requestedRoot);
  const previous = readPresentationState(root);
  const hiddenMessageIds = normalizeMessageIds([...previous.hiddenMessageIds, ...messageIds]);
  const saved = { version: 1, hiddenMessageIds };
  if (Buffer.byteLength(`${JSON.stringify(saved, null, 2)}\n`) > 1048576) {
    throw Error('Saved presentation state exceeds its byte limit.');
  }
  atomicJson(join(root, 'runtime', 'presentation.json'), saved);
  return saved;
}

/** Finite, read-only snapshot. A saved run is not evidence of a live process. */
export function readLocalView(requestedRoot) {
  const root = resolveDataRoot(requestedRoot);
  const config = loadConfig(root);
  const loaded = loadSchedules(root);
  const history = loadImportedHistory(root);
  const file = join(root, 'runtime/view.json');
  let saved = {};
  if (existsSync(file)) {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 16777216) throw Error('Saved dashboard must be a bounded regular file.');
    saved = JSON.parse(readFileSync(file, 'utf8'));
    if (saved.version !== 1) throw Error('Unsupported saved dashboard.');
  }
  const reports = [...new Map([...(saved.reports ?? []), ...history.reports]
    .filter(report => report.id !== 'patterns-offer')
    .map(report => [report.id, { ...report, body: readReport(root, report.id, report.body) }])).values()]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const presentation = readPresentationState(root);
  return {
    ...saved,
    config,
    ...loaded,
    history,
    reports,
    presentation,
    messages: saved.messages ?? [],
    runs: saved.runs ?? [],
    connection: 'offline',
    usage: UsageLedger.open(root, config.initializedAt).snapshot(),
  };
}
