import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const reportText = value => String(value ?? '')
  .replace(/<!--\s*companion-(?:publication|question):[\s\S]*?(?:-->|$)/gi, '')
  .trim();

export const runOutcomeText = run => run.result?.text || run.result?.error || run.error || '';

// Background reports open with a triage line (prompts/background.md).
const nothingNewLine = /^(?:\*\*)?nothing new\.?(?:\*\*)?$/i;
const talkBackLine = /^(?:\*\*)?(critical|useful|blocked)(?:\*\*)?:(?:\*\*)?\s+(.+)$/i;
export const reportTriage = run => {
  if (run.status !== 'completed') return null;
  const firstLine = String(run.result?.text ?? '').trim().split('\n', 1)[0].trim();
  if (nothingNewLine.test(firstLine)) return { level: 'nothing' };

  const match = firstLine.match(talkBackLine);
  if (!match) return null;
  return {
    level: match[1].toLowerCase(),
    message: match[2].replace(/\*\*$/, '').trim().slice(0, 1024),
  };
};

const reportPath = (root, id) => join(root, 'reports', `${createHash('sha256').update(String(id)).digest('hex')}.md`);
const statOrMissing = file => {
  try { return lstatSync(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};
function reportDirectory(root) {
  const directory = join(root, 'reports');
  const stat = statOrMissing(directory);
  if (stat && (!stat.isDirectory() || (stat.mode & 0o077))) throw Error('Reports directory must be a private directory.');
  return directory;
}

export function writePrivate(file, body) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
  return file;
}

export function saveReport(root, id, body) {
  if (typeof body !== 'string' || Buffer.byteLength(body) > 16777216) throw Error('Report must be bounded Markdown text.');
  mkdirSync(reportDirectory(root), { recursive: true, mode: 0o700 });
  return writePrivate(reportPath(root, id), body);
}

export function readReport(root, id, fallback) {
  reportDirectory(root);
  const file = reportPath(root, id);
  const stat = statOrMissing(file);
  if (!stat) return fallback;
  if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 16777216) throw Error('Saved report must be a private bounded regular file.');
  return readFileSync(file, 'utf8');
}

const deletedPath = root => join(root, 'runtime', 'deleted-reports.json');

/** Deleted report IDs hide reports from every inventory source; run receipts stay to prevent replays. */
export function deletedReportIds(root) {
  const file = deletedPath(root);
  const stat = statOrMissing(file);
  if (!stat) return new Set();
  if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 16777216) throw Error('Deleted reports must be a private bounded regular file.');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  if (saved?.version !== 1 || !Array.isArray(saved.ids) || saved.ids.some(id => typeof id !== 'string' || !id)) {
    throw Error('Invalid deleted report list.');
  }
  return new Set(saved.ids);
}

export function deleteReports(root, ids) {
  const deleted = deletedReportIds(root);
  for (const id of ids) {
    deleted.add(id);
    rmSync(reportPath(root, id), { force: true });
  }
  mkdirSync(join(root, 'runtime'), { recursive: true, mode: 0o700 });
  writePrivate(deletedPath(root), `${JSON.stringify({ version: 1, ids: [...deleted] }, null, 2)}\n`);
  return deleted;
}
