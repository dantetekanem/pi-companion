import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectSessionPatterns } from '../src/cli/session-patterns.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'companion-patterns-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = (name, rows) => {
    const path = join(root, name);
    writeFileSync(path, rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n'));
    return path;
  };
  const selection = sources => ({
    consent: { harness: 'pi', model: null },
    sources,
    from: '2026-10-01T00:00:00Z',
    to: '2026-10-31T23:59:59Z',
  });
  return { root, file, selection };
}
const pi = (id, content, timestamp = '2026-10-10T10:00:00Z') => ({ type: 'message', id, timestamp, message: { role: 'user', content } });

test('no opt-in reads nothing; explicit provider and date scope are required', () => {
  assert.deepEqual(collectSessionPatterns({ sources: [{ path: '/not/authorized' }] }), { status: 'not_requested' });
  assert.throws(() => collectSessionPatterns({ consent: { harness: 'other' }, sources: [], from: 'bad', to: 'bad' }), /scope|date|harness/);
});

test('Pi and Claude extract dated user-role requests and tool names, never tool arguments or assistant text', t => {
  const { file, selection } = fixture(t);
  const piFile = file('pi.jsonl', [
    { type: 'session', id: 'pi-session', version: 3 },
    pi('p1', 'Review my PRs'),
    {
      type: 'message',
      id: 'a1',
      timestamp: '2026-10-10T10:01:00Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'PRIVATE ASSISTANT' },
          { type: 'toolCall', name: 'read', arguments: { path: 'PRIVATE PATH' } },
        ],
      },
    },
    pi('p2', [{ type: 'text', text: 'Review my PRs' }], '2026-10-17T10:00:00Z'),
    pi('old', 'Old task', '2026-09-01T00:00:00Z'),
  ]);
  const claudeFile = file('claude.jsonl', [
    {
      type: 'user',
      sessionId: 'claude-session',
      uuid: 'c1',
      timestamp: '2026-10-20T10:00:00Z',
      message: { role: 'user', content: 'Prepare a summary' },
    },
    {
      type: 'user',
      uuid: 'c2',
      timestamp: '2026-10-20T10:00:00Z',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'PRIVATE RESULT' }] },
    },
    {
      type: 'user',
      isMeta: true,
      timestamp: '2026-10-20T10:00:00Z',
      message: { role: 'user', content: 'PRIVATE META' },
    },
  ]);

  const result = collectSessionPatterns(selection([
    { harness: 'pi', path: piFile },
    { harness: 'claude', path: claudeFile },
  ]));

  assert.equal(result.requests.length, 3);
  assert.equal(result.repetitions[0].count, 2);
  assert.deepEqual(result.tools, [{ name: 'read', count: 1 }]);
  assert.equal(result.coverage.inspectedFiles, 2);
  assert.ok(result.requests.every(item => item.evidenceId && item.line && item.at));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|Old task/);
  assert.equal(result.destination.harness, 'pi');
});

test('exclusions, bounds and duplicate exported events remain visible without inflating repetition counts', t => {
  const { file, selection } = fixture(t);
  const rows = [
    { type: 'session', id: 'same', version: 3 },
    pi('a', 'Review PRs'),
    pi('b', 'private project'),
    '{malformed',
    pi('c', 'x'.repeat(100)),
  ];
  const a = file('a.jsonl', rows);
  const b = file('b.jsonl', rows);
  const excluded = file('excluded.jsonl', [pi('d', 'Excluded')]);

  const result = collectSessionPatterns({
    ...selection([{ harness: 'pi', path: a }, { harness: 'pi', path: b }, { harness: 'pi', path: excluded }]),
    excludeFiles: [excluded],
    excludeText: ['private project'],
    limits: { requestChars: 20 },
  });

  assert.equal(result.requests.length, 2);
  assert.equal(result.repetitions.length, 0);
  assert.ok(result.requests.find(item => item.truncated));
  assert.ok(result.omissions.some(item => item.reason === 'malformed_line'));
  assert.ok(result.omissions.some(item => item.reason === 'duplicate_event'));
  assert.ok(result.omissions.some(item => item.reason === 'excluded_file'));
  assert.doesNotMatch(JSON.stringify(result.requests), /private project|Excluded/);
});

test('large files, symlinks and missing timestamps are omitted rather than read or assigned dates', t => {
  const { root, file, selection } = fixture(t);
  const large = file('large.jsonl', ['x'.repeat(400)]);
  const missing = file('no-date.jsonl', [{ type: 'message', id: 'undated', message: { role: 'user', content: 'No date' } }]);
  const link = join(root, 'link.jsonl');
  symlinkSync(large, link);

  const result = collectSessionPatterns({
    ...selection([{ harness: 'pi', path: large }, { harness: 'pi', path: missing }, { harness: 'pi', path: link }]),
    limits: { fileBytes: 200 },
  });

  assert.equal(result.requests.length, 0);
  assert.ok(result.omissions.some(item => item.reason === 'file_limit'));
  assert.ok(result.omissions.some(item => item.reason === 'not_regular_file'));
  assert.ok(result.omissions.some(item => item.reason === 'missing_date'));
});
