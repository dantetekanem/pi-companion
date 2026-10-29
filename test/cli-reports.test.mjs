import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveReport, readReport, reportText } from '../src/cli/reports.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'companion-report-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('ordinary Markdown is saved whole in a private file and read ahead of legacy text', t => {
  const root = fixture(t);
  const body = `# Findings\n\n${'Evidence.\n'.repeat(5000)}\n`;
  const file = saveReport(root, 'schedule:one', body);
  assert.equal(file.endsWith('.md'), true);
  assert.equal(readFileSync(file, 'utf8'), body);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, 'reports')).mode & 0o777, 0o700);
  assert.equal(readReport(root, 'schedule:one', 'stale cached text'), body);
  assert.deepEqual(readdirSync(join(root, 'reports')), [file.split('/').at(-1)]);
  assert.equal(readReport(root, 'historical', 'Preserved imported body'), 'Preserved imported body');
});

test('saved reports reject symlinks and public files rather than reading another source', t => {
  const root = fixture(t);
  const file = saveReport(root, '../untrusted-id', '# Private report');
  chmodSync(file, 0o644);
  assert.throws(() => readReport(root, '../untrusted-id', ''), /private.*regular file/i);
  rmSync(file);
  symlinkSync(join(root, 'missing-target'), file);
  assert.throws(() => readReport(root, '../untrusted-id', ''), /private.*regular file/i);
});

test('visible legacy reports strip private publication markers without dropping the report', () => {
  const body = '# Finding\n<!-- companion-publication:scope:id:hash -->\nUseful evidence.\n<!-- companion-question:id:unfinished';
  assert.equal(reportText(body), '# Finding\n\nUseful evidence.');
});
