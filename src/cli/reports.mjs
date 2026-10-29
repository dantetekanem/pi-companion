import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const reportText = value => String(value ?? '')
  .replace(/<!--\s*companion-(?:publication|question):[\s\S]*?(?:-->|$)/gi, '')
  .trim();

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

export function saveReport(root, id, body) {
  if (typeof body !== 'string' || Buffer.byteLength(body) > 16777216) throw Error('Report must be bounded Markdown text.');
  mkdirSync(reportDirectory(root), { recursive: true, mode: 0o700 });
  const file = reportPath(root, id);
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

export function readReport(root, id, fallback) {
  reportDirectory(root);
  const file = reportPath(root, id);
  const stat = statOrMissing(file);
  if (!stat) return fallback;
  if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 16777216) throw Error('Saved report must be a private bounded regular file.');
  return readFileSync(file, 'utf8');
}
