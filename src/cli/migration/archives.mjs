import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { sha256 } from './inventory.mjs';

/** Preserve history as evidence. It does not turn registry prose or notes into executable policy. */
export function importArchives(journal) {
  if (!['inventory', 'staged'].includes(journal.record.phase)) throw Error('Archive import requires inactive staging.');
  journal.verifyArchive();
  const entries = [];
  const artifacts = [];
  const directories = [];
  for (const directory of journal.record.manifest.directories.filter(item => item.category === 'notes')) {
    const path = `imported/notes${directory.relative ? `/${directory.relative}` : ''}`;
    const destination = journal.dataPath(path);
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    const stat = lstatSync(destination);
    if (!stat.isDirectory() || (stat.mode & 0o077)) throw Error('Imported history directory must be private and real.');
    directories.push({ path, source: directory.path, sourceMode: directory.mode });
  }
  for (const entry of journal.record.manifest.files.filter(item => ['registry', 'notes', 'feed'].includes(item.category))) {
    const path = entry.category === 'notes' ? `imported/notes/${entry.relative}` : `imported/${entry.category}.md`;
    const bytes = readFileSync(journal.sourcePath(entry));
    if (sha256(bytes) !== entry.sha256) throw Error('Staged historical bytes changed.');
    artifacts.push(journal.writeData(path, bytes));
    entries.push({
      path,
      source: entry.path,
      category: entry.category,
      sha256: entry.sha256,
      size: entry.size,
      sourceMode: entry.mode,
      authority: 'historical-evidence',
    });
  }
  const index = { version: 1, fingerprint: journal.record.manifest.fingerprint, entries, directories };
  artifacts.push(journal.writeData('imported/archives.json', Buffer.from(`${JSON.stringify(index, null, 2)}\n`)));
  return { entries, directories, artifacts, errors: [] };
}
