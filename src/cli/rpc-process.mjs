import { spawn } from 'node:child_process';

export const clean = value => String(value ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');

const live = new Set();
let exitHook = false;
const signalGroup = (child, signal) => {
  if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
  else child.kill(signal);
};
const reapAtExit = () => {
  for (const child of live) {
    try {
      signalGroup(child, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
};

/**
 * One Pi RPC child in its own process group. Records are LF-delimited JSON, each bounded by maxRecordBytes.
 * It never retries; failure, cancellation and exit end every waiter, and only this handle stops the child.
 */
export function startRpcProcess({
  command, args, cwd, env, spawnProcess = spawn, maxRecordBytes = 1048576, name = 'Harness', onRecord = () => {}, onFail = () => {},
}) {
  const child = spawnProcess(command, args, {
    cwd,
    shell: false,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });
  live.add(child);
  if (!exitHook) {
    exitHook = true;
    process.once('exit', reapAtExit);
  }
  const pending = new Map();
  const closed = Promise.withResolvers();
  const label = name.toLowerCase();
  let serial = 0;
  let parts = [];
  let size = 0;
  let stderr = '';
  let failure;
  let exited = false;
  let stopping = false;
  let killTimer;
  let graceTimer;
  const terminate = () => {
    if (stopping || exited) return;
    stopping = true;
    const kill = signal => {
      try {
        signalGroup(child, signal);
      } catch (error) {
        if (error.code !== 'ESRCH') failure ??= error;
      }
    };
    kill('SIGTERM');
    killTimer = setTimeout(() => kill('SIGKILL'), 500);
    killTimer.unref();
  };
  const fail = error => {
    failure ??= error;
    for (const waiter of pending.values()) waiter.reject(failure);
    pending.clear();
    onFail(failure);
    terminate();
  };
  const write = record => child.stdin.write(`${JSON.stringify(record)}\n`, error => {
    if (error && !stopping) fail(error);
  });
  const request = (type, data = {}, onResponse) => {
    if (failure || exited || !child.stdin.writable) return Promise.reject(failure ?? Error(`${name} exited.`));
    const id = `companion-${++serial}`;
    const waiter = Promise.withResolvers();
    pending.set(id, { ...waiter, onResponse });
    write({ id, type, ...data });
    return waiter.promise;
  };
  const accept = record => {
    if (!record || typeof record !== 'object' || typeof record.type !== 'string') throw Error(`Invalid ${label} event.`);
    if (record.type === 'response') {
      const waiter = pending.get(record.id);
      if (waiter) {
        pending.delete(record.id);
        if (record.success) {
          waiter.onResponse?.(record.data);
          waiter.resolve(record.data);
        } else {
          waiter.reject(Object.assign(Error(clean(record.error || `${name} command failed.`)), { commandRejected: true }));
        }
      }
    }
    onRecord(record);
  };
  const flush = bytes => {
    const line = bytes.toString('utf8').replace(/\r$/, '');
    if (line.trim()) accept(JSON.parse(line));
  };
  // Bound each record, not the stream; a long healthy run emits many records.
  const read = chunk => {
    let start = 0;
    while (!failure) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      size += end - start;
      if (size > maxRecordBytes) throw Error(`${name} output record exceeded its byte limit.`);
      if (end > start) parts.push(chunk.subarray(start, end));
      if (newline === -1) return;
      const record = Buffer.concat(parts, size);
      parts = [];
      size = 0;
      flush(record);
      start = newline + 1;
    }
  };
  child.stdout.on('data', chunk => {
    if (failure) return;
    try {
      read(chunk);
    } catch (error) {
      fail(Error(`Invalid ${label} output: ${error.message}`));
    }
  });
  child.stdout.on('end', () => {
    if (failure) return;
    try {
      if (size) flush(Buffer.concat(parts, size));
      parts = [];
      size = 0;
    } catch (error) {
      fail(error);
    }
  });
  child.stderr.on('data', chunk => { stderr = (stderr + clean(chunk)).slice(-2000); });
  child.stdin.on('error', error => { if (!stopping) fail(error); });
  child.on('error', fail);
  child.on('close', (code, signal) => {
    exited = true;
    live.delete(child);
    clearTimeout(killTimer);
    clearTimeout(graceTimer);
    const error = failure ?? Error(`${name} exited before completion (${code ?? signal}). ${stderr}`);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    closed.resolve({ code, signal, error });
  });
  return {
    pid: child.pid,
    request,
    send: record => { if (!failure && !exited && child.stdin.writable) write(record); },
    fail,
    terminate,
    /** Closing stdin asks Pi to dispose its runtime and exit; the signals only follow a missed grace period. */
    shutdown(graceMs = 5000) {
      if (!exited && !stopping) {
        child.stdin.end();
        graceTimer = setTimeout(terminate, graceMs);
        graceTimer.unref();
      }
      return closed.promise;
    },
    closed: closed.promise,
    get failure() { return failure; },
    get exited() { return exited; },
    get stderr() { return stderr; },
  };
}
