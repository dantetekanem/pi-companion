import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli/main.mjs';
import { parseSchedule } from '../src/cli/schedules.mjs';

async function run(args) {
  let text = '';
  const code = await main(args, { write: chunk => { text += chunk; } });
  return { code, text };
}

test('skill prints without a workspace and creates nothing', async t => {
  const parent = mkdtempSync(join(tmpdir(), 'companion-skill-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const home = join(parent, 'never-created');

  const { code, text } = await run(['skill', '--home', home]);

  assert.equal(code, 0);
  assert.ok(text.length > 0);
  assert.equal(existsSync(home), false);
});

test('the printed skill has the frontmatter skill loaders read', async () => {
  const { text } = await run(['skill']);

  const frontmatter = text.match(/^---\nname: (.+)\ndescription: (.+)\n---\n/);
  assert.ok(frontmatter, 'expected name and description frontmatter');
  const [, name, description] = frontmatter;
  assert.equal(name, 'pi-companion');
  assert.ok(description.length <= 1024);
  assert.doesNotMatch(description, /: /, 'a colon would break the plain YAML value');
});

test('the example schedule in the skill is one Companion accepts', async () => {
  const { text } = await run(['skill']);

  const [, example] = text.match(/```markdown\n([\s\S]*?\n)```/);
  const schedule = parseSchedule(example, 'daily', '/example.md');

  assert.equal(schedule.enabled, false);
});

test('help names the skill command', async () => {
  const { text } = await run(['--help']);

  assert.match(text, /\bskill\b/);
});
