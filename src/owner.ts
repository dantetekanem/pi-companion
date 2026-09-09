import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

type Claim = { version: 1; sessionId: string };

export class Owner {
  readonly file: string;
  constructor(private root: string) { this.file = join(root, 'owner.json'); }
  current(): string | undefined {
    let raw: string;
    try { raw = readFileSync(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const claim = JSON.parse(raw) as Claim;
    if (claim.version !== 1 || typeof claim.sessionId !== 'string' || !claim.sessionId) throw new Error('Invalid Companion owner claim.');
    return claim.sessionId;
  }
  isOwner(sessionId: string): boolean { return this.current() === sessionId; }
  acquire(sessionId: string): boolean {
    if (!sessionId) throw new Error('Companion requires an owning session.');
    const current = this.current();
    if (current !== undefined) return current === sessionId;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const temporary = join(this.root, `.owner-${randomUUID()}.tmp`);
    try {
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify({ version: 1, sessionId } satisfies Claim)); fsyncSync(fd); }
      finally { closeSync(fd); }
      try { linkSync(temporary, this.file); return true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return this.isOwner(sessionId);
        throw error;
      }
    } finally { rmSync(temporary, { force: true }); }
  }
  release(sessionId: string): boolean {
    if (!this.isOwner(sessionId)) return false;
    unlinkSync(this.file);
    return true;
  }
}
