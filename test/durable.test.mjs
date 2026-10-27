import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableCompanion } from '../src/durable.ts';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'companion-durable-'));
  const opened = [];
  const owner = { sessionId: 'owner', sessionFile: join(dir, 'owner.jsonl') };
  t.after(async () => {
    for (const runtime of opened) await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, owner, async open(candidate = owner, configured = true) {
    const runtime = await DurableCompanion.open(dir, candidate, configured);
    opened.push(runtime);
    return runtime;
  } };
}
const controls = calls => ({
  daily: async action => { calls.push(`daily:${action}`); },
  routines: async action => { calls.push(`routines:${action}`); },
});

test('real Durable SQLite retains the owner and setup receipt without any model configuration', async t => {
  const h = fixture(t), calls = [];
  const first = await h.open();
  await first.control('start', controls(calls));
  assert.equal(await first.claimSetup(), false);
  await first.close();
  const resumed = await h.open({ sessionId: 'other', sessionFile: join(h.dir, 'other.jsonl') }, false);
  assert.deepEqual((await resumed.state()).owner, h.owner);
  await resumed.recover(controls(calls));
  assert.deepEqual(calls, ['daily:start', 'routines:start']);
  assert.equal((await resumed.state()).active, true);
  assert.equal(await resumed.claimSetup(), false);
  assert.equal(statSync(join(h.dir, 'companion.sqlite')).mode & 0o777, 0o600);
});

test('cold setup is reserved once and an interrupted dispatch is not blindly replayed', async t => {
  const h = fixture(t), runtime = await h.open(h.owner, false);
  assert.equal(await runtime.claimSetup(), true);
  await runtime.close();
  const resumed = await h.open();
  assert.equal(await resumed.claimSetup(), false);
  assert.equal((await resumed.state()).setup, 'requested');
});

test('a second runtime cannot own the same storage until the first closes', async t => {
  const h = fixture(t), runtime = await h.open();
  await assert.rejects(h.open(), /already running|locked/i);
  await runtime.close();
  await h.open();
});

test('close and reopen resume only the unfinished control phase and reconcile its receipt', async t => {
  const h = fixture(t), runtime = await h.open(), calls = [];
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  let effects = 0, receipt = false;
  const running = runtime.control('start', {
    daily: async action => { calls.push(`daily:${action}`); },
    routines: async (_action, signal) => {
      if (!receipt) { effects++; receipt = true; }
      entered();
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  const rejected = assert.rejects(running);
  await ready;
  await runtime.close();
  await rejected;
  const resumed = await h.open();
  await resumed.recover({
    daily: async () => { calls.push('repeated daily'); },
    routines: async () => { if (!receipt) effects++; calls.push('reconciled routines'); },
  });
  assert.deepEqual(calls, ['daily:start', 'reconciled routines']);
  assert.equal(effects, 1);
  assert.equal((await resumed.state()).active, true);
});

test('recovery finishes an interrupted routine stop and retains the earlier daily failure', async t => {
  const h = fixture(t);
  const runtime = await h.open();
  await runtime.control('start', controls([]));
  let entered;
  const routineEntered = new Promise(resolve => { entered = resolve; });
  const stopping = runtime.control('stop', {
    daily: async () => { throw Error('daily wake changed'); },
    routines: async (_action, signal) => {
      entered();
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  const rejected = assert.rejects(stopping);
  await Promise.race([routineEntered, stopping]);
  await runtime.close();
  await rejected;

  const resumed = await h.open();
  const calls = [];
  await assert.rejects(resumed.recover(controls(calls)), /daily wake changed/);
  assert.deepEqual(calls, ['routines:stop']);
  assert.equal((await resumed.state()).active, false);
  await resumed.close();
  const settled = await h.open();
  await assert.rejects(settled.recover(controls(calls)), /daily wake changed/);
  assert.deepEqual(calls, ['routines:stop']);
});

test('stop persists failures from both controls while start remains fail-fast', async t => {
  const h = fixture(t);
  const runtime = await h.open();
  const calls = [];
  const failing = {
    daily: async action => { calls.push(`daily:${action}`); throw Error('daily unavailable'); },
    routines: async action => { calls.push(`routines:${action}`); throw Error('routines unavailable'); },
  };
  await assert.rejects(runtime.control('start', failing), /daily unavailable/);
  assert.deepEqual(calls, ['daily:start']);
  await assert.rejects(runtime.control('stop', failing), /daily unavailable.*routines unavailable/);
  assert.deepEqual(calls, ['daily:start', 'daily:stop', 'routines:stop']);
  assert.equal((await runtime.state()).active, false);
  await runtime.close();

  const resumed = await h.open();
  await assert.rejects(resumed.recover(controls(calls)), /daily unavailable.*routines unavailable/);
  assert.deepEqual(calls, ['daily:start', 'daily:stop', 'routines:stop']);
});

test('stop cancels an in-flight start before running its own controls', async t => {
  const h = fixture(t), runtime = await h.open(), calls = [];
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const starting = runtime.control('start', {
    daily: async (_action, signal) => {
      entered();
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
    routines: async () => assert.fail('cancelled start reached routines'),
  });
  const cancelled = assert.rejects(starting, /aborted/);
  await ready;
  await runtime.control('stop', controls(calls));
  await cancelled;
  assert.deepEqual(calls, ['daily:stop', 'routines:stop']);
  assert.equal((await runtime.state()).active, false);
});

test('an explicit stop supersedes an interrupted start instead of replaying its enable phase', async t => {
  const h = fixture(t), runtime = await h.open();
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const running = runtime.control('start', {
    daily: async (_action, signal) => {
      entered();
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
    routines: async () => assert.fail('interrupted start must not reach routines'),
  });
  const rejected = assert.rejects(running);
  await ready;
  await runtime.close();
  await rejected;
  const resumed = await h.open(), calls = [];
  await resumed.control('stop', controls(calls));
  assert.deepEqual(calls, ['daily:stop', 'routines:stop']);
  assert.equal((await resumed.state()).active, false);
  await resumed.close();
  const stopped = await h.open();
  await stopped.recover(controls(calls));
  assert.equal((await stopped.state()).active, false);
  assert.equal(calls.length, 2);
});
