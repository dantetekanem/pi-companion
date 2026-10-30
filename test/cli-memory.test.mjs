import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContext } from '../src/cli/context.mjs';
import { createMemoryExtension, createMemoryTool, memoryBytes, readMemory } from '../src/cli/memory.mjs';

function dataRoot(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'companion-memory-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const memoryFile = root => join(root, 'memory.md');
const change = (root, request) => createMemoryTool(root).execute('memory', request);

test('the agent can add, replace and remove items, and each change comes back as the current list', async t => {
  const root = dataRoot(t);

  await change(root, { action: 'add', text: 'Rent is due November 1' });
  await change(root, { action: 'add', text: 'Waiting on the contractor' });
  await change(root, {
    action: 'replace',
    item: 'Rent is due November 1',
    text: 'Rent for November is paid',
  });
  const removed = await change(root, { action: 'remove', item: 'Waiting on the contractor' });

  assert.deepEqual(removed.details.items, ['Rent for November is paid']);
  assert.match(removed.content[0].text, /1 of 20[\s\S]*- Rent for November is paid/);
  assert.equal(readFileSync(memoryFile(root), 'utf8'), '- Rent for November is paid\n');
  assert.equal(lstatSync(memoryFile(root)).mode & 0o077, 0);
});

test('the list stays short: a full memory refuses more until something is replaced or removed', async t => {
  const root = dataRoot(t);
  writeFileSync(memoryFile(root), Array.from({ length: 20 }, (_, index) => `- Item ${index}`).join('\n'));

  await assert.rejects(change(root, { action: 'add', text: 'One too many' }), /full/i);
  await assert.rejects(change(root, { action: 'add', text: 'x'.repeat(201) }), /Invalid memory change/);

  assert.equal(readMemory(root).length, 20);
});

test('a change must name an exact existing item and stay on one line', async t => {
  const root = dataRoot(t);
  writeFileSync(memoryFile(root), '- Keep this\n');

  await assert.rejects(change(root, { action: 'remove', item: 'Keep' }), /exact text/);
  await assert.rejects(change(root, { action: 'add', text: 'Two\nlines' }), /Invalid memory change/);
  await assert.rejects(change(root, { action: 'replace', item: 'Keep this' }), /Invalid memory change/);

  assert.deepEqual(readMemory(root), ['Keep this']);
});

test('a hand-edited file is honoured without bullets, and agents see at most the bounded list', async t => {
  const root = dataRoot(t);
  assert.deepEqual(readMemory(root), []);

  writeFileSync(memoryFile(root), `\n- Bullet\n* Star\nPlain line\n\n${Array.from({ length: 30 }, (_, index) => `- Extra ${index}`).join('\n')}\n- ${'x'.repeat(300)}\n`);

  const items = readMemory(root);
  assert.deepEqual(items.slice(0, 3), ['Bullet', 'Star', 'Plain line']);
  assert.equal(items.length, 20);

  writeFileSync(memoryFile(root), `- ${'y'.repeat(300)}\n`);
  assert.equal(readMemory(root)[0].length, 200);
});

test('replacing one item keeps hand-edited items beyond the visible bound', async t => {
  const root = dataRoot(t);
  writeFileSync(memoryFile(root), Array.from({ length: 25 }, (_, index) => `- Item ${index}`).join('\n'));

  await change(root, { action: 'remove', item: 'Item 0' });

  assert.equal(readFileSync(memoryFile(root), 'utf8').trim().split('\n').length, 24);
});

test('each turn sees the list as it is now, including edits made between turns', async t => {
  const root = dataRoot(t);
  const handlers = {};
  createMemoryExtension(root)({ on: (event, handler) => { handlers[event] = handler; } });
  const turn = () => handlers.before_agent_start({ systemPrompt: 'Base prompt.' }).systemPrompt;

  assert.match(turn(), /^Base prompt\.[\s\S]*empty/i);

  writeFileSync(memoryFile(root), '- Rent is due November 1\n');

  assert.match(turn(), /^Base prompt\.[\s\S]*- Rent is due November 1/);
});

test('a scheduled job receives memory as read-only context beside its instructions', async t => {
  const root = dataRoot(t);
  const schedule = {
    id: 'check',
    title: 'Check',
    cwd: root,
    harness: 'pi',
    model: null,
    context: [],
    prompt: 'Check things.',
  };

  const envelope = JSON.parse(await buildContext(schedule, null, ['Rent is due November 1']));

  assert.deepEqual(envelope.memory, ['Rent is due November 1']);
});

test('memory size covers the shared list and every check, and needs neither to exist', t => {
  const root = dataRoot(t);
  assert.equal(memoryBytes(root), 0);

  writeFileSync(memoryFile(root), 'x'.repeat(100));
  mkdirSync(join(root, 'checks/email'), { recursive: true });
  mkdirSync(join(root, 'checks/calendar'), { recursive: true });
  writeFileSync(join(root, 'checks/email/memory.md'), 'x'.repeat(2000));
  writeFileSync(join(root, 'checks/email/log.md'), 'x'.repeat(9000));

  assert.equal(memoryBytes(root), 2100);
});
