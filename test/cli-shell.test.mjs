import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { executeShell } from '../src/cli/shell.mjs';

const cwd = process.cwd();
function childProgram(source, inspect = () => {}) {
  return (command, args, options) => {
    inspect(command, args, options);
    return spawn(process.execPath, ['--input-type=module', '-e', source], options);
  };
}

test('legacy command/cwd and bash login argv remain literal; bounded Unicode and exit status survive child completion', async () => {
  const command = "printf '%s' '$unexpanded; data'";
  const program = "process.stdout.write('é日本語🧭'); process.stderr.write('diagnostic'); process.exitCode=7;";
  const spawnProcess = childProgram(program, (exe, args, options) => {
    assert.equal(exe, 'bash');
    assert.deepEqual(args, ['-lc', command]);
    assert.equal(options.cwd, cwd);
    assert.equal(options.shell, false);
    assert.equal(options.detached, process.platform !== 'win32');
  });

  const result = await executeShell({ command, cwd, timeoutMs: 1000 }, { spawnProcess });

  assert.equal(result.stdout, 'é日本語🧭');
  assert.equal(result.stderr, 'diagnostic');
  assert.equal(result.code, 7);
  assert.equal(result.killed, false);
  assert.equal(result.command, command);
});

test('output overflow terminates and reaps the owned child instead of claiming complete output', async () => {
  let child;
  const result = await executeShell({ command: 'synthetic', cwd, timeoutMs: 1000 }, {
    maxOutputBytes: 1024,
    spawnProcess: (...args) => child = childProgram("process.stdout.write('x'.repeat(4096)); setInterval(()=>{},1000)")(...args),
  });

  assert.equal(result.killed, true);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 1024);
  assert.ok(child.signalCode || child.exitCode !== null);
  assert.match(result.error, /output/i);
});

test('legacy timeout metadata does not prevent successful shell completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const timeoutMs of [undefined, 1, 0]) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const signals = [];
    child.kill = signal => signals.push(signal);
    const pending = executeShell({ command: 'synthetic', cwd, timeoutMs }, { spawnProcess: () => child });
    t.mock.timers.tick(600001);
    child.stdout.write('finished after ten minutes');
    child.emit('close', 0, null);
    const result = await pending;
    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'finished after ten minutes');
    assert.equal(result.killed, false);
    assert.deepEqual(signals, []);
  }
});

test('cancellation kills stubborn owned children; pre-aborted work never spawns', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const before = await executeShell({ command: 'synthetic', cwd, signal: controller.signal }, { spawnProcess: () => { calls++; } });
  assert.equal(before.interrupted, true);
  assert.equal(calls, 0);

  const cancel = new AbortController();
  let child;
  const pending = executeShell({ command: 'synthetic', cwd, timeoutMs: 1000, signal: cancel.signal }, {
    spawnProcess: (...args) => {
      child = childProgram("process.on('SIGTERM',()=>{}); process.stdout.write('ready'); setInterval(()=>{},1000)")(...args);
      child.stdout.once('data', () => cancel.abort());
      return child;
    },
  });
  const result = await pending;
  assert.equal(result.interrupted, true);
  assert.equal(result.killed, true);
  assert.equal(child.signalCode, 'SIGKILL');
});

test('invalid bounds and synchronous spawn failure are explicit and never retry', async () => {
  await assert.rejects(executeShell({ command: 'synthetic', cwd }, { maxOutputBytes: 0 }), /bounds/i);
  let calls = 0;
  const result = await executeShell({ command: 'synthetic', cwd }, {
    spawnProcess: () => {
      calls++;
      throw Error('missing executable');
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.code, null);
  assert.match(result.error, /missing executable/);
});
