import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { pinSession } from './ownership.mjs';
import { readSource, sha256 } from './inventory.mjs';

export { pinSession };

/** Storage may checkpoint/migrate SQLite on open, so it only ever sees a disposable copy. */
export async function inspectCheckpoint(journal) {
  journal.verifyArchive();
  const files = journal.record.manifest.files.filter(file => file.category === 'durable');
  const databases = files.filter(file => basename(file.path) === 'companion.sqlite');
  if (!databases.length) {
    if (files.length) throw Error('Unrecognized legacy Durable files require reconciliation.');
    return null;
  }
  if (databases.length !== 1) throw Error('Multiple legacy Durable databases require an explicit reconciliation.');
  const database = databases[0];
  const directory = mkdtempSync(join(journal.stageRoot, 'inspection-'));
  let storage;
  try {
    for (const file of files) {
      if (dirname(file.path) !== dirname(database.path) || !['companion.sqlite', 'companion.sqlite-wal', 'companion.sqlite-shm'].includes(basename(file.path)))
        throw Error('Unrecognized legacy Durable file requires reconciliation.');
      writeFileSync(join(directory, basename(file.path)), readFileSync(journal.sourcePath(file)), { flag: 'wx', mode: 0o600 });
    }
    storage = await openNodeSqliteStorage(join(directory, 'companion.sqlite'));
    const conversations = await storage.scanConversations({}, 1001, undefined, BACKGROUND_CONTEXT);
    if (conversations.next || conversations.items.length > 1000) throw Error('Legacy checkpoint conversation limit exceeded.');
    const documents = [];
    for (const conversation of conversations.items) {
      const page = await storage.scanDocuments({ kind: 'companion.lifecycle', scope: { kind: 'conversation', conversationId: conversation.id }, at: 'current' }, 2, undefined, BACKGROUND_CONTEXT);
      if (page.next) throw Error('Ambiguous legacy lifecycle checkpoint.');
      documents.push(...page.items);
    }
    if (documents.length !== 1) throw Error('Legacy checkpoint must contain one unambiguous lifecycle.');
    const document = await storage.document(documents[0].id, 'current', BACKGROUND_CONTEXT);
    const lifecycle = document?.value;
    if (document?.version !== 1 || !lifecycle?.owner?.sessionId || !lifecycle.owner.sessionFile || typeof lifecycle.active !== 'boolean'
      || !['needed', 'requested', 'ready'].includes(lifecycle.setup) || !['start', 'stop', null].includes(lifecycle.action)
      || (lifecycle.taskId !== null && (!Number.isSafeInteger(lifecycle.taskId) || lifecycle.taskId < 1))) throw Error('Unsupported legacy lifecycle checkpoint.');
    if (lifecycle.setup === 'requested') throw Error('Legacy setup is uncertain; reconcile it before adoption.');
    let cursor;
    let count = 0;
    do {
      const page = await storage.scanTasks({}, 100, cursor, BACKGROUND_CONTEXT);
      cursor = page.next;
      count += page.items.length;
      if (count > 50000) throw Error('Legacy control inspection limit exceeded.');
      if (page.items.some(task => task.state.status !== 'terminal')) throw Error('Legacy control is unfinished; inspection will not execute it.');
    } while (cursor);
    const control = lifecycle.taskId ? await storage.task(lifecycle.taskId, BACKGROUND_CONTEXT) : null;
    if (lifecycle.taskId && (!control || control.kind !== 'companion.control' || control.version !== 1
      || control.state.outcome?.status !== 'completed')) throw Error('Legacy control has no successful terminal receipt.');
    return {
      sha256: database.sha256,
      lifecycle,
      controlStatus: control?.state.status ?? null,
      controlOutcome: control?.state.outcome?.status ?? null,
      sources: files.map(({ path, sha256 }) => ({ path, sha256 })),
    };
  } finally {
    try {
      await storage?.close(BACKGROUND_CONTEXT);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

/** Copy explicitly mapped saved histories; no session discovery, provider or Harness execution. */
export function importSessions(journal, { ownership, sessions }) {
  journal.verifyArchive();
  if (ownership?.fingerprint !== journal.record.manifest.fingerprint || !ownership.shutdownReceipt || !Array.isArray(sessions)
    || new Set(sessions.map(session => session.sessionId)).size !== sessions.length) throw Error('Exact mapped session pins and ownership are required.');
  for (const id of ownership.owners) if (!sessions.some(session => session.sessionId === id)) throw Error('Every owner needs a mapped saved session.');
  if (sessions.some(session => !ownership.owners.includes(session.sessionId))) throw Error('Session is outside mapped ownership.');
  const entries = sessions.map(pin => {
    const current = pinSession(pin.sessionFile);
    for (const key of ['sessionId', 'sessionFile', 'sha256', 'size', 'origin', 'cwd', 'version']) if (pin[key] !== current[key]) throw Error('Saved session pin or identity changed.');
    if (pin.sessionId === ownership.main.sessionId && pin.sha256 !== ownership.main.sha256) throw Error('Selected main session pin changed.');
    return { ...current, bytes: readSource({ path: current.sessionFile, sha256: current.sha256, size: current.size }) };
  });
  const artifacts = [];
  const imported = [];
  for (const { bytes, ...entry } of entries) {
    const path = `imported/sessions/${sha256(entry.sessionId)}.jsonl`;
    artifacts.push(journal.writeData(path, bytes));
    imported.push({ ...entry, path });
    if (entry.sessionId === ownership.main.sessionId) artifacts.push(journal.writeData('sessions/main.jsonl', bytes));
  }
  const selected = imported.find(session => session.sessionId === ownership.main.sessionId);
  if (!selected) throw Error('Selected main session has no mapped history.');
  const main = { ...selected, path: 'sessions/main.jsonl' };
  const index = {
    version: 1,
    fingerprint: ownership.fingerprint,
    main,
    sessions: imported,
    checkpoint: ownership.checkpoint,
    references: ownership.references,
  };
  artifacts.push(journal.writeData('imported/sessions/index.json', Buffer.from(`${JSON.stringify(index, null, 2)}\n`)));
  return { artifacts, main, sessions: imported };
}
