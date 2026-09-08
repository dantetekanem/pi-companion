import type { Theme } from '@earendil-works/pi-coding-agent';
import { matchesKey, Text, truncateToWidth } from '@earendil-works/pi-tui';
import { label, type Result } from './result.ts';

export class Reader {
  private offset = 0;
  private maximum = 0;
  private pageSize = 1;
  constructor(private item: Result, private theme: Theme, private rows: () => number, private done: (read: boolean) => void) {}
  invalidate(): void {}
  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) return this.done(false);
    if (data === 'r') return this.done(true);
    if (matchesKey(data, 'up')) this.offset--;
    if (matchesKey(data, 'down')) this.offset++;
    if (matchesKey(data, 'pageUp')) this.offset -= this.pageSize;
    if (matchesKey(data, 'pageDown') || data === ' ') this.offset += this.pageSize;
    this.offset = Math.max(0, Math.min(this.maximum, this.offset));
  }
  render(width: number): string[] {
    const content = [this.item.body, '', 'Source checks', ...this.item.checks.map(c => `${c.source} — ${c.outcome}\n${c.detail}`)].join('\n\n');
    const lines = new Text(content, 0, 0).render(Math.max(1, width));
    this.pageSize = Math.max(1, this.rows() - 3);
    this.maximum = Math.max(0, lines.length - this.pageSize);
    this.offset = Math.min(this.offset, this.maximum);
    return [this.theme.fg('accent', label(this.item)),
      ...lines.slice(this.offset, this.offset + this.pageSize),
      this.theme.fg('dim', `${this.offset + 1}–${Math.min(lines.length, this.offset + this.pageSize)}/${lines.length} · ↑↓/PgUp/PgDn scroll · r mark read · Esc back`),
    ].map(line => truncateToWidth(line, Math.max(1, width)));
  }
}
