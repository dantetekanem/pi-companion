import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, symlinkSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initialize } from '../src/cli/config.mjs';
import { main } from '../src/cli/main.mjs';
import { readPresentationState } from '../src/cli/view.mjs';

function fixture(t, isTTY = false) {
  const root = mkdtempSync(join(tmpdir(), 'companion-main-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initialize(root, { cwd: root });
  const signals = new EventEmitter();
  const output = { isTTY, text: '', write(text) { this.text += text; } };
  return { root, signals, output };
}

function freshHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'companion-first-run-'));
  const original = { HOME: process.env.HOME, COMPANION_HOME: process.env.COMPANION_HOME };
  process.env.HOME = home;
  delete process.env.COMPANION_HOME;
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });
  return { home, root: join(home, '.companion') };
}

for (const [args, isTTY] of [[[], true], [['run'], false]]) {
  test(`${args[0] ?? 'interactive launch'} initializes the default workspace without touching legacy data`, async t => {
    const { home, root } = freshHome(t);
    const legacy = join(home, '.pi/agent/companion');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'state.json'), '{"legacy":"preserved"}');
    const signals = new EventEmitter();
    let opens = 0;
    const dependencies = {
      signals,
      input: { isTTY },
      startDashboard: () => ({ update() {}, stop() {} }),
      openApplication: async selectedRoot => {
        assert.equal(selectedRoot, root);
        assert.equal(JSON.parse(readFileSync(join(root, 'config.json'))).version, 2);
        opens++;
        signals.emit('SIGTERM');
        return { close: async () => {} };
      },
    };
    assert.equal(await main(args, { isTTY, write() {} }, dependencies), 0);
    const config = readFileSync(join(root, 'config.json'), 'utf8');
    assert.equal(await main(args, { isTTY, write() {} }, dependencies), 0);
    assert.equal(readFileSync(join(root, 'config.json'), 'utf8'), config);
    assert.equal(opens, 2);
    for (const cadence of ['daily', 'weekly', 'monthly']) {
      assert.equal(existsSync(join(root, 'schedules', cadence)), true);
    }
    assert.equal(readFileSync(join(legacy, 'state.json'), 'utf8'), '{"legacy":"preserved"}');
    assert.equal(existsSync(`${legacy}-control`), false);
    assert.equal(existsSync(join(root, 'migration')), false);
  });
}

test('finite reads do not initialize, and connected startup cannot bypass an incomplete migration', async t => {
  const { root } = freshHome(t);
  const dependencies = {
    input: { isTTY: true },
    openApplication: () => { throw Error('Must not open'); },
  };
  for (const [args, isTTY] of [[[], false], [['--plain'], true], [['schedules'], true], [['run', '--plain'], true]]) {
    await assert.rejects(main(args, { isTTY, write() {} }, dependencies), { code: 'ENOENT' });
    assert.equal(existsSync(root), false);
  }
  mkdirSync(join(root, 'migration'), { recursive: true });
  for (const args of [[], ['run']]) {
    await assert.rejects(main(args, { isTTY: true, write() {} }, dependencies), /Migration is incomplete/);
    assert.equal(existsSync(join(root, 'config.json')), false);
  }
});

test('the published pi-companion executable runs from PATH outside the checkout and preserves failure exits', t => {
  const root = mkdtempSync(join(tmpdir(), 'companion-bin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const entry = manifest.bin['pi-companion'];
  assert.equal(typeof entry, 'string');
  const executable = join(root, 'pi-companion');
  const home = join(root, 'home');
  symlinkSync(fileURLToPath(new URL(`../${entry}`, import.meta.url)), executable);
  const options = {
    cwd: root,
    env: { ...process.env, PATH: `${root}:${process.env.PATH}` },
    encoding: 'utf8',
    timeout: 10000,
  };

  const initialized = spawnSync('pi-companion', ['init', '--home', home], options);
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(existsSync(join(home, 'config.json')), true);
  assert.ok(initialized.stdout.length > 0);

  const rejected = spawnSync('pi-companion', ['invalid-command', '--home', home], options);
  assert.equal(rejected.status, 1);
  assert.ok(rejected.stderr.length > 0);
});

test('explicit headless command holds one owner until a signal, then closes and removes handlers', async t => {
  const h = fixture(t);
  const started = Promise.withResolvers();
  let closes = 0;
  const work = main(['run', '--home', h.root], h.output, {
    signals: h.signals,
    input: { isTTY: false },
    openApplication: async (_root, options) => {
      assert.equal(await options.askQuestion({ question: 'Headless?' }), undefined);
      started.resolve();
      return { close: async () => { closes++; } };
    },
  });

  await started.promise;
  h.signals.emit('SIGTERM');

  assert.equal(await work, 0);
  assert.equal(closes, 1);
  assert.equal(h.signals.listenerCount('SIGTERM'), 0);
  assert.equal(h.signals.listenerCount('SIGINT'), 0);
});

test('dashboard paints before connection, wires sends and restores terminal on startup failure', async t => {
  const h = fixture(t, true);
  let painted = false;
  let stopped = false;

  await assert.rejects(main(['--home', h.root], h.output, {
    signals: h.signals,
    input: { isTTY: true },
    startDashboard: (view, handlers, options) => {
      painted = true;
      assert.equal(view.connection, 'offline');
      assert.equal(typeof handlers.send, 'function');
      assert.equal(options.theme.cwd, view.config.main.cwd);
      return { update() {}, askQuestion: request => request.choices[0].value, stop() { stopped = true; } };
    },
    openApplication: async (_root, options) => {
      assert.equal(painted, true);
      assert.equal(await options.askQuestion({ choices: [{ value: 'keep' }] }), 'keep');
      throw Error('Synthetic startup failure');
    },
  }), /Synthetic startup failure/);

  assert.equal(stopped, true);
  assert.equal(h.signals.listenerCount('SIGTERM'), 0);
});

test('interactive dashboard wiring persists clear state through the activated root', async t => {
  const h = fixture(t, true);
  const started = Promise.withResolvers();
  let handlers;
  const work = main(['--home', h.root], h.output, {
    signals: h.signals,
    input: { isTTY: true },
    startDashboard: (_view, next) => {
      handlers = next;
      started.resolve();
      return { update() {}, stop() {} };
    },
    openApplication: async () => ({ close: async () => {} }),
  });

  await started.promise;
  assert.deepEqual((await handlers.clear(['visible'])).hiddenMessageIds, ['visible']);
  assert.deepEqual(readPresentationState(h.root).hiddenMessageIds, ['visible']);
  h.signals.emit('SIGTERM');
  assert.equal(await work, 0);
});

test('interactive reset awaits the connected application and refreshes the dashboard', async t => {
  const h = fixture(t, true);
  const started = Promise.withResolvers();
  const resetStarted = Promise.withResolvers();
  const releaseReset = Promise.withResolvers();
  const updates = [];
  let handlers;
  const work = main(['--home', h.root], h.output, {
    signals: h.signals,
    input: { isTTY: true },
    startDashboard: (_view, next) => {
      handlers = next;
      started.resolve();
      return { update: view => updates.push(view), stop() {} };
    },
    openApplication: async (_root, options) => ({
      async reset() {
        resetStarted.resolve();
        await releaseReset.promise;
        const view = { connection: 'connected', refreshed: true };
        options.onChange(view);
        return { sessionId: 'fresh-session' };
      },
      async close() {},
    }),
  });
  t.after(async () => {
    releaseReset.resolve();
    h.signals.emit('SIGTERM');
    await work;
  });

  await started.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof handlers.reset, 'function');

  let completed = false;
  const reset = handlers.reset().then(result => {
    completed = true;
    return result;
  });
  await resetStarted.promise;
  assert.equal(completed, false);
  releaseReset.resolve();
  assert.deepEqual(await reset, { sessionId: 'fresh-session' });
  assert.equal(completed, true);
  assert.ok(updates.some(view => view.refreshed));

  h.signals.emit('SIGTERM');
  assert.equal(await work, 0);
});

test('interactive dashboard cancellation delegates outcomes to the connected application', async t => {
  const h = fixture(t, true);
  const started = Promise.withResolvers();
  const requested = [];
  let handlers;
  const work = main(['--home', h.root], h.output, {
    signals: h.signals,
    input: { isTTY: true },
    startDashboard: (_view, next) => {
      handlers = next;
      started.resolve();
      return { update() {}, stop() {} };
    },
    openApplication: async () => ({
      kill: async runId => {
        requested.push(runId);
        if (runId === 'error') throw Error('Cancellation unavailable.');
        return runId === 'live-job';
      },
      async close() {},
    }),
  });

  await started.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await handlers.kill('live-job'), true);
  assert.equal(await handlers.kill('stale-job'), false);
  await assert.rejects(handlers.kill('error'), /Cancellation unavailable/);
  assert.deepEqual(requested, ['live-job', 'stale-job', 'error']);
  h.signals.emit('SIGTERM');
  assert.equal(await work, 0);
});

test('plain status never opens an application even on a TTY', async t => {
  const h = fixture(t, true);
  const code = await main(['status', '--plain', '--home', h.root], h.output, {
    input: { isTTY: true },
    openApplication: () => { throw Error('Must not open'); },
  });

  assert.equal(code, 0);
  assert.match(h.output.text, /Main not connected/);
});

test('reports lists the whole inventory and delete removes only known reports', async t => {
  const h = fixture(t);
  const report = (id, at) => ({ id, title: id, body: `Body ${id}`, at, outcome: 'completed' });
  mkdirSync(join(h.root, 'runtime'), { mode: 0o700 });
  writeFileSync(join(h.root, 'runtime/view.json'), JSON.stringify({
    version: 1,
    reports: [
      report('check:2026-01-01', '2026-01-01T09:00:00Z'),
      report('check:2026-01-08', '2026-01-08T09:00:00Z'),
    ],
  }));

  assert.equal(await main(['reports', '--home', h.root], h.output), 0);
  const listed = JSON.parse(h.output.text).map(item => item.id);
  assert.deepEqual(listed, ['check:2026-01-08', 'check:2026-01-01']);

  const withUnknown = main(['reports', 'delete', 'check:2026-01-01', 'missing', '--home', h.root], h.output);
  await assert.rejects(withUnknown, /missing/);

  h.output.text = '';
  assert.equal(await main(['reports', 'delete', 'check:2026-01-01', '--home', h.root], h.output), 0);
  assert.deepEqual(JSON.parse(h.output.text), { deleted: ['check:2026-01-01'], before: 2, after: 1 });

  await assert.rejects(main(['status', 'extra', '--home', h.root], h.output), /Unknown/);
});
