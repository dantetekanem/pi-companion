import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { CURSOR_MARKER, getCellDimensions, getKeybindings, setCellDimensions, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { createDashboard, startDashboard } from '../src/cli/ui.mjs';

const snapshot = {
  config: { background: { harness: 'pi', model: null, effort: 'medium' } },
  counts: { daily: 2, weekly: 1, monthly: 0 },
  schedules: [{ id: 'recap', title: 'Morning recap', cadence: 'daily', at: '09:00', enabled: true }],
  reports: [
    { id: 'one', title: 'First report', at: '2026-10-26', body: 'Initial observations', outcome: 'findings' },
    { id: 'two', title: 'Second report', at: '2026-10-27', body: '你好 👋\nNext line', outcome: 'no_change' },
  ],
  messages: [],
  connection: 'offline',
  runs: [],
  usage: null,
};

class FakeTerminal {
  columns = 120;
  rows = 40;
  writes = [];
  start(input, resize) {
    this.input = input;
    this.resize = resize;
  }
  stop() {}
  drainInput() { return Promise.resolve(); }
  write(data) { this.writes.push(data); }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  get kittyProtocolActive() { return false; }
}

const screen = (controller, width, height) => stripTerminalSequences(controller.render(width, height).join('\n'));

test('report selection, detail scroll and refresh preserve identity; separate conversation is reachable', () => {
  const ui = createDashboard(snapshot);
  assert.equal(ui.state().focus, 'composer');
  assert.equal(ui.state().view, 'conversation');
  ui.input('\x1b[C');
  assert.match(screen(ui, 120, 40), /First report/);
  ui.input('\x1b[B');
  ui.input('\r');
  assert.match(screen(ui, 120, 40), /你好 👋/);
  ui.input('\x1b[6~');
  const selected = ui.state();
  ui.update({ ...snapshot, reports: [{ id: 'new', title: 'New', at: '', body: '', outcome: '' }, ...snapshot.reports] });
  assert.equal(ui.state().selectedId, 'two');
  assert.equal(ui.state().scroll, selected.scroll);
  ui.input('\x1b[D');
  assert.equal(ui.state().view, 'conversation');
  assert.equal(ui.state().focus, 'composer');
});

test('invalid schedules remain discoverable and scrollable at every supported layout', () => {
  const runs = Array.from({ length: 20 }, (_, index) => ({
    state: 'invalid',
    title: `/tmp/home/schedules/daily/broken-${index}.md: expected JSON metadata between --- lines`,
  }));
  const ui = createDashboard({ ...snapshot, connection: 'connected', runs, schedules: [] });

  for (const [width, height] of [[120, 40], [80, 24], [60, 18]]) {
    assert.match(screen(ui, width, height), /20.*invalid|invalid.*20/i);
    ui.input('\x1b[D');
    assert.equal(ui.state().view, 'schedules');
    assert.match(screen(ui, width, height), /broken-0\.md/);
    assert.match(screen(ui, width, height), /expected\s+JSON\s+metadata/);
    for (let page = 0; page < 20; page++) ui.input('\x1b[6~');
    assert.match(screen(ui, width, height), /broken-19\.md/);
    const lastPage = screen(ui, width, height);
    ui.input('\x1b[5~');
    assert.notEqual(screen(ui, width, height), lastPage);
    assert.ok(ui.render(width, height).every(line => visibleWidth(line) <= width));
    ui.input('\x1b');
    assert.equal(ui.state().view, 'conversation');
  }

  ui.update(snapshot);
  ui.input('\x1b[D');
  assert.match(screen(ui, 60, 18), /Morning recap/);
});

test('offline input is disabled, editing shortcuts stay in composer and draft survives Escape and failed send', async () => {
  const ui = createDashboard(snapshot);
  ui.input('q');
  ui.input('🌍');
  ui.input('\x1b[D');
  ui.input('好');
  assert.equal(ui.state().draft, 'q好🌍');
  assert.ok(ui.render(80, 24).join('\n').includes(`q好${CURSOR_MARKER}`));
  ui.input('\x1b[C');
  assert.ok(ui.render(80, 24).join('\n').includes(`q好🌍${CURSOR_MARKER}`));
  ui.input('\x1b');
  assert.equal(ui.state().draft, 'q好🌍');
  assert.match(screen(ui, 80, 24), /Offline.*send unavailable/i);
  let sent = 0;
  ui.update({ ...snapshot, connection: 'connected' });
  ui.setHandlers({
    send: async () => {
      sent++;
      throw Error('failed');
    },
  });
  ui.input('\r');
  await ui.pending();
  assert.equal(sent, 1);
  assert.equal(ui.state().draft, 'q好🌍');
  assert.match(screen(ui, 80, 24), /failed/i);
});

test('chat opens at the latest message and pages through history while input remains active', () => {
  const messages = Array.from({ length: 20 }, (_, i) => ({ role: 'assistant', content: `Message ${i} ` + 'hello '.repeat(20) }));
  const ui = createDashboard({ ...snapshot, messages });
  assert.match(screen(ui, 60, 18), /Message 19/);
  for (let i = 0; i < 20; i++) ui.input('\x1b[5~');
  assert.match(screen(ui, 60, 18), /Message 0\b/);
  for (let i = 0; i < 20; i++) ui.input('\x1b[6~');
  assert.match(screen(ui, 60, 18), /Message 19/);
  ui.input('draft');
  assert.equal(ui.state().focus, 'composer');
  assert.equal(ui.state().draft, 'draft');
});

test('arrow keys cycle views with an empty composer and keep editing nonempty drafts native', () => {
  const ui = createDashboard(snapshot);
  for (const [input, view] of [
    ['\x1b[C', 'reports'], ['\x1b[C', 'schedules'], ['\x1b[C', 'conversation'],
    ['\x1b[D', 'schedules'], ['\x1b[D', 'reports'], ['\x1b[D', 'conversation'],
  ]) {
    ui.input(input);
    assert.equal(ui.state().view, view);
  }
  ui.input('unsent');
  ui.input('\x1b[D');
  ui.input('X');
  ui.input('\x1b[C');
  ui.input('!');
  assert.equal(ui.state().draft, 'unsenXt!');
  assert.equal(ui.state().view, 'conversation');
});

test('accepted sends clear draft and reveal conversation; Ctrl+C quits even while editing', async () => {
  const sent = [];
  let quits = 0;
  const ui = createDashboard({ ...snapshot, connection: 'connected' }, {
    send: async text => { sent.push(text); },
    onQuit: () => { quits++; },
  });
  ui.input('こんにちは');
  ui.input('\r');
  await ui.pending();
  assert.deepEqual(sent, ['こんにちは']);
  assert.equal(ui.state().draft, '');
  assert.equal(ui.state().view, 'conversation');
  assert.equal(ui.state().focus, 'composer');
  ui.input('unsent');
  ui.input('\x03');
  assert.equal(quits, 1);
  assert.equal(ui.state().draft, 'unsent');
});

test('Unicode, paste and terminal controls are bounded across wide, narrow and resize layouts', () => {
  const ui = createDashboard({
    ...snapshot,
    reports: [{
      id: 'evil',
      title: '\x1b[2J题',
      body: '\x1b]8;;https://bad\x07unsafe\x1b]8;;\x07 ' + '🌍'.repeat(100),
      outcome: 'findings',
    }],
  });
  ui.input('\x1b[C');
  ui.input('\r');
  for (const [width, height] of [[120, 40], [80, 24], [60, 18], [30, 8]]) {
    const lines = ui.render(width, height);
    assert.ok(lines.length <= height);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    assert.doesNotMatch(lines.join(''), /\x1b\[2J|\x1b\]|https:\/\/bad/);
  }
  ui.input('\x1b[D');
  ui.input('\x1b[200~hello 🌍\x1b[201~');
  assert.match(ui.state().draft, /hello 🌍/);
});

test('fullscreen input reaches dashboard pagination and composer boundaries', t => {
  const terminal = new FakeTerminal();
  const bindings = getKeybindings().getUserBindings();
  const runs = Array.from({ length: 20 }, (_, index) => ({
    state: 'invalid',
    title: `broken-${index}.md: invalid schedule`,
  }));
  const ui = startDashboard({ ...snapshot, runs }, {}, { terminal });
  t.after(() => ui.stop());

  terminal.input('\x1b[D');
  terminal.input('\x1b[6~');
  assert.equal(ui.state().scroll, 8);
  terminal.input('\x1b[5~');
  assert.equal(ui.state().scroll, 0);
  for (let page = 0; page < 20; page++) terminal.input('\x1b[6~');
  assert.match(screen(ui, 60, 18), /broken-19\.md/);

  terminal.input('\x1b[C');
  terminal.input('middle');
  terminal.input('\x1b[H');
  terminal.input('start-');
  terminal.input('\x1b[F');
  terminal.input('-end');
  assert.equal(ui.state().draft, 'start-middle-end');
  terminal.input('\x1b[6~');
  assert.equal(ui.state().draft, 'start-middle-end');

  ui.stop();
  assert.deepEqual(getKeybindings().getUserBindings(), bindings);
});

test('view arrows preserve an open question and its selected choice', async t => {
  const terminal = new FakeTerminal();
  const ui = startDashboard(snapshot, {}, { terminal });
  t.after(() => ui.stop());
  for (const view of ['schedules', 'reports', 'conversation']) {
    terminal.input('\x1b[D');
    assert.equal(ui.state().view, view);
  }
  terminal.input('\x1b[C');
  const answer = ui.askQuestion({
    question: 'Continue?',
    choices: [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }],
  });
  terminal.input('\x1b[B');
  terminal.input('\x1b[C');
  terminal.input('\x1b[D');
  assert.equal(ui.state().view, 'reports');
  assert.equal(ui.state().focus, 'question');
  assert.match(screen(ui, 120, 40), /→ Yes/);
  terminal.input('\x1b');
  assert.equal(await answer, null);
});

test('real TUI routes mouse wheels to the chat, not the editor or outer screen', async t => {
  const terminal = new FakeTerminal();
  const messages = Array.from({ length: 30 }, (_, i) => ({ role: 'assistant', content: `Message ${i}` }));
  const ui = startDashboard({ ...snapshot, messages }, {}, { terminal });
  t.after(() => ui.stop());
  terminal.input('draft');
  await new Promise(resolve => setImmediate(resolve));
  for (const [columns, rows] of [[120, 40], [80, 24], [60, 18]]) {
    terminal.columns = columns;
    terminal.rows = rows;
    terminal.resize();
    const latest = screen(ui, columns, rows);
    terminal.input('\x1b[<64;10;8M');
    assert.equal(ui.state().scroll, 3);
    assert.notEqual(screen(ui, columns, rows), latest);
    terminal.input(`\x1b[<65;10;${rows - 1}M`); // Wheel over composer does not scroll history.
    assert.equal(ui.state().scroll, 3);
    terminal.input('\x1b[<65;10;8M');
    assert.equal(ui.state().scroll, 0);
    assert.equal(ui.state().draft, 'draft');
    assert.equal(ui.state().focus, 'composer');
  }
  ui.stop();
  assert.ok(terminal.writes.some(value => value.includes('\x1b[?1006h')));
  assert.ok(terminal.writes.some(value => value.includes('\x1b[?1006l')));
});

test('terminal cell-size replies invalidate the mounted component without losing input or reports', t => {
  const terminal = new FakeTerminal();
  const dimensions = getCellDimensions();
  const ui = startDashboard(snapshot, {}, { terminal });
  t.after(() => {
    ui.stop();
    setCellDimensions(dimensions);
  });
  terminal.input('\x1b[C');
  terminal.input('\r');
  ui.update({ ...snapshot, reports: [{ ...snapshot.reports[0], body: 'Updated report' }] });
  assert.match(screen(ui, 120, 40), /Updated report/);
  terminal.input('\x1b[D');
  terminal.input('draft');

  terminal.input('\x1b[6;20;10t');
  assert.deepEqual(getCellDimensions(), { widthPx: 10, heightPx: 20 });
  assert.equal(ui.state().draft, 'draft');
  terminal.columns = 60;
  terminal.rows = 18;
  terminal.resize();
  terminal.input('\x1b[6;24;12t');
  terminal.input('!');

  assert.equal(ui.state().draft, 'draft!');
});

test('fullscreen lifecycle preserves the draft and restores the parent terminal', t => {
  const terminal = new FakeTerminal();
  let quits = 0;
  const ui = startDashboard(snapshot, { onQuit: () => { quits++; } }, { terminal });
  t.after(() => ui.stop());
  terminal.input('hello');
  terminal.input('\x1b');
  ui.update({ ...snapshot, reports: [...snapshot.reports, { id: 'three', title: 'Third', body: '', at: '', outcome: '' }] });
  terminal.columns = 60;
  terminal.rows = 18;
  terminal.resize();
  assert.equal(ui.state().draft, 'hello');
  terminal.input('\x1b[D');
  assert.equal(ui.state().view, 'conversation');
  terminal.input('\x03');
  assert.equal(quits, 1);
  assert.ok(terminal.writes[0].startsWith('\x1b[?1049h'));
  assert.ok(terminal.writes.every(data => !data.includes('\x1b[?1049l')));
  ui.stop();
  const restored = terminal.writes.find(data => data.includes('\x1b[?1049l'));
  assert.ok(restored);
  assert.equal(stripVTControlCharacters(restored.split('\x1b[?1049l')[1]), '');
});

test('native editing supports word/line shortcuts, undo, multiline submission and history', async () => {
  const sent = [];
  const ui = createDashboard({ ...snapshot, connection: 'connected' }, { send: async text => sent.push(text) });
  ui.input('first second');
  ui.input('\x17'); // Ctrl+W
  assert.equal(ui.state().draft, 'first ');
  ui.input('\x19'); // Ctrl+Y
  ui.input('\x1bb'); // Alt+B
  ui.input('new ');
  assert.equal(ui.state().draft, 'first new second');
  ui.input('\x01'); // Ctrl+A
  ui.input('\x0b'); // Ctrl+K
  assert.equal(ui.state().draft, '');
  ui.input('\x1f'); // Ctrl+- / undo
  assert.equal(ui.state().draft, 'first new second');
  ui.input('\x05'); // Ctrl+E
  ui.input('\n'); // Ctrl+J
  ui.input('next line');
  ui.input('\r');
  await ui.pending();
  assert.deepEqual(sent, ['first new second\nnext line']);
  ui.input('\x1b[A');
  assert.equal(ui.state().draft, sent[0]);
});

test('pending acceptance preserves edits and long multiline drafts remain within the terminal', async () => {
  const gate = Promise.withResolvers();
  const ui = createDashboard({ ...snapshot, connection: 'connected' }, { send: () => gate.promise });
  ui.input('first');
  ui.input('\r');
  ui.input(' second');
  gate.resolve();
  await ui.pending();
  assert.equal(ui.state().draft, 'first second');
  for (let i = 0; i < 20; i++) {
    ui.input('\n');
    ui.input(`line ${i}`);
  }
  for (const [width, height] of [[120, 40], [80, 24], [60, 18]]) {
    const lines = ui.render(width, height);
    assert.ok(lines.length <= height);
    assert.ok(lines.every(value => visibleWidth(value) <= width));
    assert.ok(lines.some(value => value.includes(CURSOR_MARKER)));
  }
});

test('only visible chat entries have author blocks and busy feedback lives in the footer', () => {
  const messages = [
    { role: 'user', content: 'Question' },
    { role: 'assistant', content: '' },
    { role: 'assistant', content: '  ' },
    { role: 'assistant', content: 'Reply' },
  ];
  const ui = createDashboard({ ...snapshot, messages, busy: true, connection: 'connected' });
  const rendered = screen(ui, 80, 24).split('\n');
  assert.equal(rendered.filter(value => value.trim() === 'Companion').length, 1);
  assert.match(rendered.slice(-2).join('\n'), /Thinking/);
  ui.update({ ...snapshot, messages, busy: false, connection: 'connected' });
  assert.doesNotMatch(screen(ui, 80, 24).split('\n').slice(-2).join('\n'), /Thinking/);
});

test('fullscreen editor loads namespaced Pi typing bindings without changing the file', t => {
  const agentDir = mkdtempSync(join(tmpdir(), 'companion-keybindings-'));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  writeFileSync(join(agentDir, 'keybindings.json'), JSON.stringify({ 'tui.editor.cursorLineStart': 'ctrl+q' }));
  const terminal = new FakeTerminal();
  const ui = startDashboard(snapshot, {}, { terminal, agentDir });
  t.after(() => ui.stop());
  terminal.input('end');
  terminal.input('\x11');
  terminal.input('start ');
  assert.equal(ui.state().draft, 'start end');
});

test('selectable questions preserve drafts, require confirmation, and cancel on Escape or shutdown', async t => {
  const terminal = new FakeTerminal();
  const ui = startDashboard({ ...snapshot, connection: 'connected', messages: [{ id: 'main', role: 'assistant', content: 'Retained main chat' }] }, {}, { terminal });
  t.after(() => ui.stop());
  const request = {
    question: 'Keep these routines paused?',
    choices: Array.from({ length: 6 }, (_, i) => ({
      value: `choice-${i}`,
      label: `Choice ${i}: ${'a long readable answer '.repeat(2)}`,
    })),
  };
  terminal.input('my draft');
  const answer = ui.askQuestion(request);
  let settled = false;
  answer.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(await ui.askQuestion(request), undefined); // No competing question replaces it.
  for (let i = 0; i < 5; i++) terminal.input('\x1b[B');
  for (const [width, height] of [[120, 40], [80, 24], [60, 18]]) {
    const lines = ui.render(width, height);
    assert.ok(lines.length <= height);
    assert.match(stripTerminalSequences(lines.join('\n')), /Choice 5/);
    assert.match(stripTerminalSequences(lines.join('\n')), /Retained main chat/);
    assert.ok(lines.every(value => visibleWidth(value) <= width));
  }
  terminal.input('\r');
  assert.equal(await answer, 'choice-5');
  assert.equal(ui.state().draft, 'my draft');
  assert.equal(ui.state().focus, 'composer');
  const cancelled = ui.askQuestion(request);
  terminal.input('\x1b');
  assert.equal(await cancelled, null);
  assert.equal(ui.state().draft, 'my draft');
  const pending = ui.askQuestion(request);
  ui.stop();
  assert.equal(await pending, null);
});

test('footer questions retain the main view and scroll while paging long text independently', async () => {
  for (const [width, height] of [[120, 40], [80, 24], [60, 18]]) {
    const ui = createDashboard({ ...snapshot, messages: [{ id: 'main', role: 'assistant', content: 'Main conversation retained' }] });
    ui.input('\x1b[C');
    ui.input('\r');
    ui.input('\x1b[6~');
    const before = ui.state();
    const abort = new AbortController();
    const answer = ui.askQuestion({
      question: 'Footer question ' + 'long question '.repeat(50),
      choices: [{ value: 'yes', label: 'Yes ' + 'long choice '.repeat(50) + 'CHOICE END' }],
    }, abort.signal);
    let rendered = screen(ui, width, height);
    assert.equal(ui.state().view, before.view);
    assert.match(rendered, /Initial observations/);
    assert.match(rendered, /Footer question/);
    assert.match(rendered, /→ Yes/);
    for (let i = 0; i < 40; i++) { ui.input('\x1b[6~'); screen(ui, width, height); }
    rendered = screen(ui, width, height);
    assert.match(rendered, /CHOICE END/);
    assert.equal(ui.state().scroll, before.scroll);
    assert.ok(ui.render(width, height).length <= height);
    assert.ok(ui.render(width, height).every(value => visibleWidth(value) <= width));
    abort.abort();
    assert.equal(await answer, null);
    assert.deepEqual(ui.state(), before);
  }
});

test('/reset waits for backend acceptance and retains draft and chat on failure or unavailable callback', async () => {
  for (const reset of [undefined, () => { throw Error('busy'); }]) {
    const ui = createDashboard(snapshot, { reset });
    ui.input('/reset');
    ui.input('\r');
    await ui.pending();
    assert.equal(ui.state().draft, '/reset');
    assert.match(ui.state().notice, /Reset failed/);
  }
  const gate = Promise.withResolvers();
  let calls = 0;
  const ui = createDashboard(snapshot, { reset: () => { calls++; return gate.promise; } });
  ui.input('/reset');
  ui.input('\r');
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(ui.state().draft, '/reset');
  gate.resolve();
  await ui.pending();
  assert.equal(ui.state().draft, '');
  assert.match(ui.state().notice, /reset/i);
});

test('entered text while busy or awaiting acceptance is forwarded through the normal send callback', async () => {
  const gate = Promise.withResolvers();
  const sent = [];
  const ui = createDashboard({ ...snapshot, connection: 'connected', busy: true }, {
    send: text => { sent.push(text); return sent.length === 1 ? gate.promise : Promise.resolve(); },
  });
  ui.input('first');
  ui.input('\r');
  await Promise.resolve();
  ui.input('\x01');
  ui.input('\x0b');
  ui.input('steer');
  ui.input('\r');
  await Promise.resolve();
  gate.resolve();
  await ui.pending();
  assert.deepEqual(sent, ['first', 'steer']);
});

test('/clear hides only visible chat across refreshes while local commands never become prompts', async () => {
  const messages = [{ id: 'old', role: 'assistant', content: 'Old answer' }];
  const initial = { ...snapshot, messages, busy: true, context: { tokens: 100, contextWindow: 1000, percent: 10 } };
  let calls = 0;
  const ui = createDashboard(initial, { send: () => { calls++; } });
  const submit = async text => {
    ui.input(text);
    ui.input('\r');
    await ui.pending();
  };
  await submit('/clear'); // Available even offline.
  assert.equal(ui.state().draft, '');
  assert.doesNotMatch(screen(ui, 80, 24), /Old answer/);
  ui.update({ ...initial, messages: [...messages, { id: 'new', role: 'assistant', content: 'New answer' }] });
  assert.match(screen(ui, 80, 24), /New answer/);
  assert.doesNotMatch(screen(ui, 80, 24), /Old answer/);
  assert.equal(initial.messages.length, 1);
  await submit('/not-a-command');
  assert.match(ui.state().notice, /Unknown command/);
  assert.equal(calls, 0);
});

test('/clear persists exact visible IDs and never resurrects them from an older refresh', async () => {
  const messages = [
    { id: 'already-hidden', role: 'assistant', content: 'Already hidden' },
    { id: 'visible', role: 'assistant', content: 'Visible answer' },
    { id: 'blank', role: 'assistant', content: '  ' },
  ];
  const cleared = [];
  const ui = createDashboard({ ...snapshot, messages, presentation: { hiddenMessageIds: ['already-hidden'] } }, {
    clear: ids => {
      cleared.push(ids);
      return { hiddenMessageIds: ['already-hidden', 'visible'] };
    },
  });
  ui.input('/clear');
  ui.input('\r');
  await ui.pending();
  assert.deepEqual(cleared, [['visible']]);
  assert.equal(ui.state().draft, '');
  assert.doesNotMatch(screen(ui, 80, 24), /Visible answer/);

  ui.update({ ...snapshot, messages: [...messages, { id: 'new', role: 'assistant', content: 'New answer' }], presentation: { hiddenMessageIds: ['already-hidden'] } });
  assert.doesNotMatch(screen(ui, 80, 24), /Visible answer/);
  assert.match(screen(ui, 80, 24), /New answer/);
});

test('/clear keeps the draft and visible chat when persistence fails', async () => {
  const ui = createDashboard({ ...snapshot, messages: [{ id: 'old', role: 'assistant', content: 'Old answer' }] }, {
    clear: () => { throw Error('disk full'); },
  });
  ui.input('/clear');
  ui.input('\r');
  await ui.pending();
  assert.equal(ui.state().draft, '/clear');
  assert.match(screen(ui, 80, 24), /Old answer/);
  assert.match(ui.state().notice, /Clear failed.*disk full/);
});

test('Schedules groups live background jobs, sorts active schedules first and keeps offline truth', () => {
  const now = () => Date.parse('2026-10-28T00:03:00Z');
  const schedules = [
    {
      id: 'later',
      title: 'Later check',
      cadence: 'daily',
      at: '09:00',
      enabled: true,
      nextRun: { state: 'scheduled', at: '2026-10-29T09:00:00Z' },
    },
    {
      id: 'recap',
      title: 'Morning recap',
      cadence: 'daily',
      at: '08:00',
      enabled: true,
      nextRun: { state: 'running' },
    },
  ];
  const runs = [
    {
      id: 'main',
      title: 'Main turn',
      state: 'running',
      kind: 'main',
      harness: 'pi',
      model: 'fixture/local',
      effort: 'high',
      cwd: '/tmp/main',
      startedAt: '2026-10-28T00:00:00Z',
    },
    {
      id: 'run-active',
      title: 'Morning recap',
      state: 'running',
      kind: 'background',
      scheduleId: 'recap',
      harness: 'claude',
      model: 'fixture/local',
      effort: 'high',
      cwd: '/tmp/job-1',
      startedAt: '2026-10-28T00:00:00Z',
    },
    {
      id: 'run-orphan',
      title: 'Removed check',
      state: 'running',
      kind: 'background',
      scheduleId: 'missing',
      harness: 'pi',
      model: 'fixture/local',
      effort: 'medium',
      cwd: '/tmp/job-2',
      startedAt: '2026-10-28T00:01:00Z',
    },
  ];
  const initial = {
    ...snapshot,
    counts: { daily: 2, weekly: 0, monthly: 0 },
    schedules,
    connection: 'connected',
    runs,
  };
  const ui = createDashboard(initial, {}, { now });
  ui.input('\x1b[C');
  ui.input('\x1b[C');
  let rendered = screen(ui, 120, 40);
  assert.match(rendered, /connected · 2 running/);
  assert.ok(rendered.indexOf('Morning recap') < rendered.indexOf('Later check'));
  assert.match(rendered, /claude.*fixture\/local.*high/);
  for (const [width, height] of [[120, 40], [80, 24], [60, 18]]) {
    screen(ui, width, height);
    assert.ok(ui.render(width, height).length <= height);
    assert.ok(ui.render(width, height).every(line => visibleWidth(line) <= width));
    while (ui.state().scroll > 0) ui.input('\x1b[5~');
  }
  assert.match(rendered, /Orphan scheduled job.*missing/);

  ui.update({ ...initial, runs: runs.map(run => ({ ...run, state: 'completed' })), schedules: schedules.map(schedule => ({ ...schedule, nextRun: { state: 'scheduled', at: '2026-10-29T09:00:00Z' } })) });
  rendered = screen(ui, 80, 24);
  assert.equal(ui.state().view, 'schedules');
  assert.doesNotMatch(rendered, /run-active|Orphan scheduled job/);

  ui.update({ ...initial, connection: 'offline' });
  rendered = screen(ui, 120, 40);
  assert.match(rendered, /Activity unavailable/);
  assert.doesNotMatch(rendered, /Orphan scheduled job/);
  ui.input('\x1b[C');
  assert.equal(ui.state().view, 'conversation');
});

test('report list caps selection at the latest 25, keeps the total and opens its final item', () => {
  let now = Date.parse('2026-10-28T00:02:00Z');
  const reports = Array.from({ length: 80 }, (_, i) => ({ id: String(i), title: `Report ${i}`, at: new Date(now - i * 60000).toISOString(), body: `Detail ${i}` }));
  const ui = createDashboard({ ...snapshot, reports }, {}, { now: () => now });
  ui.input('\x1b[C');
  for (const [width, height] of [[120, 40], [80, 24], [60, 18]]) {
    for (let i = 0; i < 24; i++) ui.input('\x1b[B');
    assert.equal(ui.state().selectedId, '24');
    const rendered = ui.render(width, height).join('\n');
    assert.equal(ui.state().view, 'reports');
    assert.match(rendered, /\x1b\[38;2;255;121;198m\x1b\[1mReport 24/);
    assert.ok(rendered.split('\n').every(value => visibleWidth(value) <= width));
    ui.input('\x1b[B');
    assert.equal(ui.state().selectedId, '24');
    ui.input('\r');
    assert.match(screen(ui, width, height), /Detail 24/);
    ui.input('\x1b');
  }
  ui.input('\r');
  assert.match(screen(ui, 120, 40), /24 minutes ago/);
  now += 86400000;
  assert.match(screen(ui, 120, 40), /1 day ago/);
});

test('schedule lifecycle survives snapshot refreshes without inventing completion', () => {
  const ui = createDashboard({ ...snapshot, connection: 'connected', usage: { usd: 1.25 } });
  assert.match(screen(ui, 120, 40), /\$1\.25 est\./);
  ui.input('\x1b[D');
  for (const [state, reason, label] of [
    ['blocked', 'missing_final_receipt', 'missing final receipt'],
    ['blocked', 'interrupted_attempt', 'interrupted attempt'],
    ['pending', 'awaiting_scheduler', 'awaiting scheduler'],
    ['completed', undefined, 'Completed'],
    ['failed', undefined, 'Failed'],
    ['cancelled', undefined, 'Cancelled'],
    ['expired', undefined, 'Expired'],
  ]) {
    ui.update({ ...snapshot, connection: 'connected', schedules: [{
      ...snapshot.schedules[0], nextRun: { state, reason, at: null },
    }] });
    assert.match(screen(ui, 120, 40), new RegExp(label));
    assert.equal(ui.state().view, 'schedules');
  }
});

const liveJob = id => ({ id, title: 'E-mail follow-ups', state: 'running', kind: 'background', scheduleId: 'mail' });
const liveSnapshot = { ...snapshot, connection: 'connected', runs: [liveJob('a'), liveJob('b')] };

test('live tabs keep run identity without stealing focus and ignore composer input', () => {
  const ui = createDashboard(liveSnapshot);
  ui.input('draft');
  ui.update({ ...liveSnapshot, runs: [liveJob('c'), ...liveSnapshot.runs] });
  assert.equal(ui.state().draft, 'draft');
  assert.equal(ui.state().view, 'conversation');
  ui.input('\x01');
  ui.input('\x0b'); // Clear the draft with native editing before view navigation.
  ui.input('\x1b[D');
  assert.equal(ui.state().view, 'job:b');
  assert.ok(!ui.render(80, 24).join('').includes(CURSOR_MARKER));
  ui.input('not a prompt');
  ui.input('\r');
  assert.equal(ui.state().draft, '');
  ui.update({ ...liveSnapshot, runs: [liveJob('b'), liveJob('a')] });
  assert.equal(ui.state().view, 'job:b');
  ui.input('\x1b[C');
  assert.equal(ui.state().view, 'job:a');
  ui.update({ ...liveSnapshot, connection: 'offline' });
  assert.equal(ui.state().view, 'conversation');
  ui.input('\x1f');
  assert.equal(ui.state().draft, 'draft');
});

test('k cancels only the selected live job, reports outcomes honestly and stays normal Chat input', async () => {
  const killed = [];
  let result = true;
  const ui = createDashboard(liveSnapshot, {
    kill: async id => {
      killed.push(id);
      if (result instanceof Error) throw result;
      return result;
    },
  });

  ui.input('k');
  assert.equal(ui.state().draft, 'k');
  assert.deepEqual(killed, []);

  ui.input('\x1b');
  ui.input('\x01');
  ui.input('\x0b');
  ui.input('\x1b[D');
  ui.input('k');
  await ui.pending();
  assert.deepEqual(killed, ['b']);
  assert.equal(ui.state().view, 'job:b');
  assert.match(ui.state().notice, /accepted/i);

  result = false;
  ui.input('\x1b[D');
  ui.input('k');
  await ui.pending();
  assert.deepEqual(killed, ['b', 'a']);
  assert.match(ui.state().notice, /no owned running job/i);

  result = Error('Cancellation refused');
  ui.input('k');
  await ui.pending();
  assert.match(ui.state().notice, /Kill failed: Cancellation refused/);
  assert.match(screen(ui, 80, 24), /Kill failed: Cancellation refused/);
  assert.equal(ui.state().view, 'job:a');

  ui.update({ ...liveSnapshot, runs: [] });
  assert.equal(ui.state().view, 'conversation');
});

test('selected live completion retains its exact filtered report across later updates and questions', async () => {
  const ui = createDashboard(liveSnapshot);
  ui.input('\x1b[D');
  const answer = ui.askQuestion({ question: 'Continue?', choices: [{ value: 'yes', label: 'Yes' }] });
  const completed = { id: 'b', title: 'Exact saved report', body: 'Authoritative no-change summary', outcome: 'no_change' };
  ui.update({ ...liveSnapshot, runs: [liveJob('a')], completedJobReports: { b: completed } });
  ui.input('\x1b');
  assert.equal(await answer, null);
  assert.equal(ui.state().view, 'reports');
  assert.equal(ui.state().focus, 'detail');
  assert.equal(ui.state().selectedId, 'b');
  ui.update({ ...liveSnapshot, runs: [], reports: [] });
  assert.match(screen(ui, 80, 24), /Authoritative no-change summary/);
  ui.input('\x1b');
  assert.equal(ui.state().focus, 'reports');
  const other = createDashboard(liveSnapshot);
  other.update({ ...liveSnapshot, runs: [], completedJobReports: { b: completed } });
  assert.equal(other.state().view, 'conversation');
  other.update(liveSnapshot);
  other.input('\x1b[D');
  const cancelled = other.askQuestion({ question: 'Stay?', choices: [{ value: 'yes', label: 'Yes' }] });
  other.update({ ...snapshot, runs: [] });
  other.input('\x1b');
  assert.equal(await cancelled, null);
  assert.equal(other.state().view, 'conversation');
});

test('live parent activity follows the bottom, pages and wheels safely at all supported sizes', () => {
  const blocks = Array.from({ length: 30 }, (_, i) => ({ id: String(i), kind: 'assistant', text: `Progress ${i}\n\nReadable paragraph` }));
  const initial = { ...liveSnapshot, jobActivity: { b: blocks } };
  const ui = createDashboard(initial);
  ui.input('\x1b[D');
  for (const [width, height] of [[120, 40], [80, 24], [60, 18]]) {
    assert.match(screen(ui, width, height), /Progress 29/);
    for (let i = 0; i < 30; i++) ui.input('\x1b[5~');
    assert.match(screen(ui, width, height), /Progress 0\b/);
    for (let i = 0; i < 30; i++) ui.input('\x1b[6~');
    screen(ui, width, height);
    ui.handleMouse({ type: 'wheel', y: 9, wheelDelta: -3 });
    assert.equal(ui.state().scroll, 3);
    ui.handleMouse({ type: 'wheel', y: 9, wheelDelta: 3 });
    assert.equal(ui.state().scroll, 0);
    const lines = ui.render(width, height);
    assert.ok(lines.length <= height);
    assert.ok(lines.every(value => visibleWidth(value) <= width));
  }
  ui.update({ ...initial, jobActivity: { b: [...blocks, { id: 'tool', kind: 'tool', name: '\x1b[2Jsearch', state: 'completed', input: '{"query":"term"}', output: 'Matched file.txt\nFinal result' }] } });
  assert.match(screen(ui, 60, 18), /search.*completed/);
  assert.match(screen(ui, 60, 18), /"query":"term"/);
  assert.match(screen(ui, 60, 18), /Matched file.txt\n\s+Final result/);
  assert.doesNotMatch(ui.render(60, 18).join(''), /\x1b\[2J/);
});

test('crowded job headers keep the selected tab visible without overflowing the viewport', () => {
  const runs = Array.from({ length: 16 }, (_, i) => ({ ...liveJob(String(i)), title: `Check ${i}` }));
  const ui = createDashboard({ ...liveSnapshot, runs });
  ui.input('\x1b[D');
  for (const [width, height] of [[120, 40], [80, 24], [60, 18]]) {
    const lines = ui.render(width, height);
    assert.ok(lines.some(value => value.includes('\x1b[38;2;255;121;198m\x1b[1mCheck 15')));
    assert.ok(lines.length <= height);
    assert.ok(lines.every(value => visibleWidth(value) <= width));
  }
});

test('non-TTY status stays finite, local and ANSI-free', t => {
  const root = mkdtempSync(join(tmpdir(), 'companion-ui-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, ['src/cli/main.mjs', ...args, '--home', root], { encoding: 'utf8', timeout: 5000 });
  assert.equal(run('init').status, 0);
  const status = run('status');
  assert.equal(status.status, 0);
  assert.match(status.stdout, /Main not connected/);
  assert.doesNotMatch(status.stdout, /\x1b/);
});
