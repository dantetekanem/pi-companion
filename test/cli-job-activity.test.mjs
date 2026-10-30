import test from 'node:test';
import assert from 'node:assert/strict';
import { JobActivity } from '../src/cli/job-activity.mjs';

const update = (type, extra = {}) => ({ type: 'message_update', assistantMessageEvent: { type, contentIndex: 0, ...extra } });

for (const [boundary, markHidden] of [
  ['event.display', event => { event.display = false; }],
  ['message.display', event => { event.message = { display: false }; }],
  ['assistantMessageEvent.display', event => { event.assistantMessageEvent.display = false; }],
  ['assistantMessageEvent.content.display', event => { event.assistantMessageEvent.content = { display: false }; }],
]) {
  test(`message updates stay hidden after ${boundary} is false`, () => {
    const feed = new JobActivity();
    feed.accept({ type: 'message_start', message: { role: 'assistant' } });
    feed.accept(update('text_delta', { delta: 'Public before' }));

    const hiddenUpdate = update('text_delta', { delta: 'HIDDEN_BOUNDARY' });
    markHidden(hiddenUpdate);
    feed.accept(hiddenUpdate);
    feed.accept(update('text_delta', { delta: 'HIDDEN_DELTA' }));
    feed.accept(update('text_end', { content: 'HIDDEN_UPDATE_FINAL' }));
    assert.deepEqual(feed.snapshot().map(entry => entry.text), ['Public before']);

    feed.accept({ type: 'message_end', message: { role: 'assistant', content: [
      { type: 'text', text: 'HIDDEN_MESSAGE_FINAL' },
    ] } });

    feed.accept({ type: 'message_start', message: { role: 'assistant' } });
    feed.accept(update('text_delta', { delta: 'Public after' }));
    feed.accept({ type: 'message_end', message: { role: 'assistant', content: [
      { type: 'text', text: 'Public after' },
    ] } });

    assert.deepEqual(feed.snapshot().map(entry => entry.text), ['Public before', 'Public after']);
  });
}

test('public custom messages preserve complete Unicode display history', () => {
  const feed = new JobActivity();
  const text = '🌍你好'.repeat(12000);
  feed.accept({ type: 'message_end', message: { role: 'custom', display: true, content: 'Visible custom' } });
  feed.accept({ type: 'message_end', message: { role: 'custom', display: true, content: [{ type: 'text', text }] } });
  assert.deepEqual(feed.snapshot().map(entry => entry.text), ['Visible custom', text]);
});

test('compact RPC reconciles text and tool snapshots without duplicating streamed output', () => {
  const feed = new JobActivity();
  feed.accept({ type: 'message_start', message: { role: 'assistant' } });
  feed.accept(update('text_delta', { delta: 'Hel' }));
  feed.accept(update('text_delta', { delta: 'lo' }));
  feed.accept(update('text_end', { content: 'Hello!' }));
  feed.accept({ type: 'tool_execution_start', toolCallId: 't', toolName: 'read', args: { path: 'file.txt' } });
  feed.accept({ type: 'tool_execution_update', toolCallId: 't', toolName: 'read', partialResult: { content: [{ type: 'text', text: 'Part' }] } });
  assert.equal(feed.snapshot().at(-1).output, 'Part');
  feed.accept({ type: 'tool_execution_update', toolCallId: 't', toolName: 'read', partialResult: { content: [{ type: 'text', text: 'Partial' }] } });
  assert.equal(feed.snapshot().at(-1).output, 'Partial');
  feed.accept({ type: 'tool_execution_end', toolCallId: 't', isError: true, result: { content: [{ type: 'text', text: 'Failed to read' }], details: { internal: 'not display content' } } });
  feed.accept({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] } });
  feed.accept({ type: 'message_start', message: { role: 'assistant' } });
  feed.accept(update('text_delta', { delta: 'Next' }));
  const entries = feed.snapshot();
  assert.deepEqual(entries.map(({ id, ...entry }) => entry), [
    { kind: 'assistant', text: 'Hello!' }, { kind: 'tool', name: 'read', state: 'failed', input: '{\n  "path": "file.txt"\n}', output: 'Failed to read' },
    { kind: 'assistant', text: 'Next' },
  ]);
  feed.accept(update('text_end', { content: 'Final' }));
  assert.equal(entries.at(-1).text, 'Next');
  feed.accept(update('text_delta', { contentIndex: 2, delta: 'Second block' }));
  feed.accept({ type: 'message_end', message: { role: 'assistant', content: [
    { type: 'text', text: 'Final' }, { type: 'thinking', thinking: 'SECRET' }, { type: 'text', text: 'Reconciled' },
  ] } });
  assert.deepEqual(feed.snapshot().filter(entry => entry.kind === 'assistant').map(entry => entry.text), ['Hello!', 'Final', 'Reconciled']);
});

test('complete parent text, tool names, inputs and outputs survive beyond former preview limits', () => {
  const feed = new JobActivity();
  const text = 'Beginning\n' + 'x'.repeat(40000) + '\nEnd';
  const name = 'read'.repeat(50);
  feed.accept({ type: 'tool_execution_start', toolCallId: 'large', toolName: name, args: { text } });
  feed.accept({ type: 'tool_execution_end', toolCallId: 'large', result: { content: [{ type: 'text', text }] } });
  for (let i = 0; i < 100; i++) {
    feed.accept({ type: 'message_start', message: { role: 'assistant' } });
    feed.accept(update('text_delta', { delta: `${i}:${text}` }));
    feed.accept({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: `${i}:${text}` }] } });
  }
  const entries = feed.snapshot();
  assert.equal(entries.length, 101);
  assert.equal(entries[0].name, name);
  assert.equal(entries[0].input, JSON.stringify({ text }, null, 2));
  assert.equal(entries[0].output, text);
  assert.equal(entries[1].text, `0:${text}`);
  assert.equal(entries[100].text, `99:${text}`);
});

test('authoritative message end removes superseded preview blocks', () => {
  const feed = new JobActivity();
  feed.accept(update('text_delta', { delta: 'Superseded' }));
  feed.accept({ type: 'message_end', message: { role: 'assistant', content: [] } });
  assert.deepEqual(feed.snapshot(), []);
});

test('unsafe, hidden and malformed records are ignored; visible content stays terminal-safe', () => {
  const feed = new JobActivity();
  for (const event of [null, {}, { type: 'extension_ui_request', text: 'SECRET' },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'SECRET', display: false }] } },
    update('thinking_delta', { delta: 'SECRET' }), { type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'SECRET' }] } },
    { type: 'message_end', message: { role: 'custom', content: 'SECRET' } },
    { type: 'message_start', message: { role: 'custom', display: false } }, update('text_delta', { delta: 'SECRET' }),
  ]) assert.doesNotThrow(() => feed.accept(event));
  assert.deepEqual(feed.snapshot(), []);
  feed.accept({ type: 'message_end', message: { role: 'custom' } });
  feed.accept({ type: 'message_start', display: false, message: { role: 'assistant' } });
  feed.accept(update('text_delta', { delta: 'SECRET' }));
  assert.deepEqual(feed.snapshot(), []);
  feed.accept({ type: 'message_end', message: { role: 'assistant', content: [] } });
  feed.accept({ type: 'message_start', message: { role: 'assistant' } });
  feed.accept({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '\x1b[31mVisible\x1b[0m\r\x00' }, { type: 'toolCall', id: 'c', name: 'read', arguments: { path: 'file.txt' } }] } });
  feed.accept({ type: 'tool_execution_end', toolCallId: 'c', result: { content: [{ type: 'text', text: 'File content' }] } });
  assert.equal(feed.snapshot()[0].text, 'Visible');
  assert.equal(feed.snapshot()[1].state, 'completed');
  assert.equal(feed.snapshot()[1].input, '{\n  "path": "file.txt"\n}');
  assert.equal(feed.snapshot()[1].output, 'File content');
});
