import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type LocationPaths = { locationRoot?: string };
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const locationFile = (paths: LocationPaths, workspace: string) =>
  join(paths.locationRoot ?? tmpdir(), `pi-companion-${process.getuid?.() ?? 'user'}-${encodeURIComponent(workspace)}.json`);

export async function saveCompanionLocation(pi: ExtensionAPI, paths: LocationPaths, active: () => boolean): Promise<void> {
  if (process.env.HERDR_ENV !== '1') return;
  try {
    const result = await pi.exec('herdr', ['pane', 'current', '--current'], { timeout: 1000 });
    if (!active() || result.code !== 0 || result.killed) return;
    const pane = JSON.parse(result.stdout).result?.pane;
    if (!pane || !nonempty(pane.pane_id) || !nonempty(pane.workspace_id)) return;
    const file = locationFile(paths, pane.workspace_id), temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ workspace: pane.workspace_id, pane: pane.pane_id }), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, file);
    } finally { rmSync(temporary, { force: true }); }
  } catch { /* A location handoff must not block Companion startup. */ }
}

export function companionTailNotice(paths: LocationPaths): string | undefined {
  const workspace = process.env.HERDR_WORKSPACE_ID;
  if (process.env.HERDR_ENV !== '1' || !nonempty(workspace)) return;
  try {
    const location = JSON.parse(readFileSync(locationFile(paths, workspace), 'utf8'));
    if (location?.workspace !== workspace || !nonempty(location.pane) || location.pane === process.env.HERDR_PANE_ID) return;
    return `${readFileSync(new URL('./prompts/tail.md', import.meta.url), 'utf8')}\nCompanion location: pane ${location.pane} (workspace ${workspace})`;
  } catch { /* Missing or invalid location files produce no notice. */ }
}
