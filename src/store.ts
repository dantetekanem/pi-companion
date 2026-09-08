import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { validateResult, type State } from './result.ts';

export class Store {
  readonly file: string;
  constructor(private root: string, sessionId: string) {
    if (!sessionId) throw new Error('Companion requires an owning session.');
    this.file = join(root, `${createHash('sha256').update(sessionId).digest('hex')}.json`);
  }
  load(): State {
    let raw: string;
    try { raw = readFileSync(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, items: [], paused: [], stopping: [] };
      throw error;
    }
    const state = JSON.parse(raw);
    if (state.stopping === undefined) state.stopping = [];
    if (state.version !== 1 || !Array.isArray(state.items) || !Array.isArray(state.paused) || !Array.isArray(state.stopping)) throw new Error('Invalid Companion storage.');
    const ids = new Set<string>();
    for (const item of state.items) {
      const { savedAt, readAt, ...result } = item;
      validateResult(result);
      if (!Number.isFinite(Date.parse(savedAt)) || (readAt !== undefined && !Number.isFinite(Date.parse(readAt))) || ids.has(item.id)) throw new Error('Invalid saved result.');
      ids.add(item.id);
    }
    for (const receipt of state.paused) {
      if (!['id', 'signature', 'disabledAt'].every(key => typeof receipt[key] === 'string')) throw new Error('Invalid schedule receipt.');
    }
    for (const request of state.stopping) {
      if (typeof request.id !== 'string' || typeof request.signature !== 'string') throw new Error('Invalid stop request.');
    }
    return state;
  }
  save(state: State): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); }
      finally { closeSync(fd); }
      renameSync(temporary, this.file);
    } finally { rmSync(temporary, { force: true }); }
  }
  ingest(input: unknown): boolean {
    const result = validateResult(input), state = this.load();
    const existing = state.items.find(item => item.id === result.id);
    if (existing) {
      const { savedAt, readAt, ...previous } = existing;
      if (!isDeepStrictEqual(previous, result)) throw new Error('Companion result ID already exists with different content.');
      return false;
    }
    state.items.push({ ...result, savedAt: new Date().toISOString() });
    this.save(state);
    return true;
  }
  markRead(id: string): void {
    const state = this.load(), item = state.items.find(item => item.id === id);
    if (!item) throw new Error('Companion result not found.');
    if (item.readAt) return;
    item.readAt = new Date().toISOString();
    this.save(state);
  }
}
