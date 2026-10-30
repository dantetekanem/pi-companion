import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { atomicJson, initialize, loadConfig, validateConfig } from '../src/cli/config.mjs';
import { buildInvocation, runHarness } from '../src/cli/harnesses.mjs';
import { piCommand, piEnvironment, validateLauncher } from '../src/cli/launcher.mjs';

const launcher = { command: ['my-pi-launcher', 'pi'], env: { EXAMPLE_MODE: '1' }, managedExtensions: true };
const id = 'f094b0ba-036c-4abc-9198-745fd1226765';
const finished = "send({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Done' }] } }); send({ type: 'agent_settled' });";

function request(t, extra = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'companion-launcher-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return { id, harness: 'pi', cwd, model: 'test/model', effort: 'medium', prompt: 'Check.', sessionFile: join(cwd, 'job.jsonl'), ...extra };
}
function fake(program, calls = []) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return spawn(process.execPath, ['--input-type=module', '-e', program], options);
  };
}
const rpc = body => `
let input = '';
const received = [];
const send = event => process.stdout.write(JSON.stringify(event) + '\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  let end;
  while ((end = input.indexOf('\\n')) >= 0) {
    const cmd = JSON.parse(input.slice(0, end));
    input = input.slice(end + 1);
    const reply = data => send({ type: 'response', id: cmd.id, command: cmd.type, success: true, data });
    if (cmd.type === 'get_state') reply({ sessionId: 'job', thinkingLevel: 'medium', model: { provider: 'test', id: 'model' } });
    else if (cmd.type === 'get_session_stats') reply({ sessionId: 'job', cost: 0.1 });
    else if (cmd.type === 'prompt') { reply({ disposition: 'started' }); ${body} }
    else if (cmd.type === 'extension_ui_response') received.push(cmd);
  }
});
`;

test('a launcher is optional and validated strictly', () => {
  const names = count => Object.fromEntries(Array.from({ length: count }, (_, index) => [`NAME_${index}`, '1']));
  for (const good of [
    undefined, launcher, { command: ['pi'] }, { command: ['my-pi-launcher', 'pi'], env: {} },
    { command: ['launcher-wrapper', 'run', 'pi'], managedExtensions: false },
    { command: ['my-pi-launcher'], env: { MONKEY_MODE: '1', EXAMPLE_EMPTY: '' } },
    { command: ['my-pi-launcher'], env: names(20) },
  ]) {
    assert.doesNotThrow(() => validateLauncher(good), JSON.stringify(good));
  }
  for (const bad of [
    null, 'my-pi-launcher pi', [], {}, { command: [] }, { command: 'my-pi-launcher pi' }, { command: [''] }, { command: ['  '] },
    { command: ['-launcher', 'pi'] }, { command: ['my-pi-launcher', 7] }, { command: ['my-pi-launcher', 'pi\n'] },
    { command: ['my-pi-launcher', 'pi\u0000'] }, { command: Array.from({ length: 9 }, () => 'my-pi-launcher') },
    { command: ['my-pi-launcher'], env: null }, { command: ['my-pi-launcher'], env: [] }, { command: ['my-pi-launcher'], env: 'A=1' },
    { command: ['my-pi-launcher'], env: { lower: '1' } }, { command: ['my-pi-launcher'], env: { '1A': '1' } },
    { command: ['my-pi-launcher'], env: { A: 1 } }, { command: ['my-pi-launcher'], env: { A: 'x\ny' } },
    { command: ['my-pi-launcher'], env: names(21) },
    ...['EXAMPLE_API_KEY', 'EXAMPLE_ACCESS_TOKEN', 'EXAMPLE_AUTH_HEADER', 'EXAMPLE_PASSWORD', 'EXAMPLE_CLIENT_SECRET', 'KEY', 'EXAMPLE_APIKEY']
      .map(name => ({ command: ['my-pi-launcher'], env: { [name]: 'x' } })),
    { command: ['my-pi-launcher'], managedExtensions: 'yes' }, { command: ['my-pi-launcher'], managedExtensions: 1 },
    { command: ['my-pi-launcher'], shell: true },
  ]) {
    assert.throws(() => validateLauncher(bad), /launcher/, JSON.stringify(bad));
  }
});

test('configuration carries a validated launcher through save and load and rejects a bad one', t => {
  const root = mkdtempSync(join(tmpdir(), 'companion-launcher-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = initialize(root, { cwd: root, now: '2026-01-01T00:00:00Z' });
  assert.equal(config.launcher, undefined);
  assert.equal(validateConfig({ ...config, launcher }).launcher, launcher);
  atomicJson(join(root, 'config.json'), { ...config, launcher });
  assert.deepEqual(loadConfig(root).launcher, launcher);
  writeFileSync(join(root, 'config.json'), JSON.stringify({ ...config, launcher: { command: ['-x'] } }));
  assert.throws(() => loadConfig(root), /launcher/);
  assert.throws(() => validateConfig({ ...config, launcher: null }), /launcher/);
  assert.throws(() => validateConfig({ ...config, launcher: { command: ['my-pi-launcher'], env: { EXAMPLE_API_KEY: 'x' } } }), /not a credential/);
});

test('without a launcher a job still starts bare pi with the offline environment', async t => {
  assert.deepEqual(piCommand(undefined, ['--mode', 'rpc']), { command: 'pi', args: ['--mode', 'rpc'] });
  const calls = [];
  await runHarness(request(t), { spawnProcess: fake(rpc(finished), calls) });
  assert.equal(calls[0].command, 'pi');
  assert.equal(calls[0].args[0], '--mode');
  assert.deepEqual(calls[0].options.env, { ...process.env, PI_OFFLINE: '1', PI_TELEMETRY: '0' });
});

test('with a launcher every job spawns its command first, with its environment and no shell', async t => {
  const calls = [];
  const input = request(t, { launcher, purpose: 'compatibility-check' });
  const result = await runHarness(input, { spawnProcess: fake(rpc(finished), calls) });
  assert.equal(result.status, 'completed');
  assert.equal(calls[0].command, 'my-pi-launcher');
  assert.deepEqual(calls[0].args.slice(0, 5), ['pi', '--mode', 'rpc', '--session', input.sessionFile]);
  assert.equal(calls[0].args[calls[0].args.indexOf('--model') + 1], 'test/model');
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.cwd, input.cwd);
  assert.deepEqual(calls[0].options.env, { ...process.env, EXAMPLE_MODE: '1' }, 'the launcher keeps its own network and telemetry defaults');
  assert.deepEqual(piEnvironment(launcher), calls[0].options.env, 'nothing but the inherited environment and the launcher’s own is added');
  await assert.rejects(runHarness({ ...input, launcher: { command: ['-x'] } }, { spawnProcess: fake('') }), /launcher/);
});

test('a managed launcher never passes --no-extensions and still keeps the other isolation flags', t => {
  for (const purpose of ['migration-repair', 'reflection', 'session-patterns']) {
    const managed = buildInvocation(request(t, { launcher, purpose }));
    assert.equal(managed.command, 'my-pi-launcher');
    assert.ok(!managed.args.includes('--no-extensions'));
    for (const flag of ['--no-tools', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '--system-prompt']) {
      assert.ok(managed.args.includes(flag), `${purpose} keeps ${flag}`);
    }
    const plain = buildInvocation(request(t, { launcher: { ...launcher, managedExtensions: false }, purpose }));
    assert.ok(plain.args.includes('--no-extensions'));
    assert.equal(plain.command, 'my-pi-launcher');
    assert.ok(buildInvocation(request(t, { purpose })).args.includes('--no-extensions'));
  }
  const ordinary = buildInvocation(request(t, { launcher }));
  assert.ok(!ordinary.args.includes('--no-extensions'));
  assert.ok(!ordinary.args.includes('--no-tools'));
});

test('a dialog from any extension in a job is declined, so an unattended job never waits on a person', { timeout: 5000 }, async t => {
  const events = [];
  const result = await runHarness(request(t, { launcher }), {
    onEvent: event => events.push(event.type),
    spawnProcess: fake(rpc(`
      send({ type: 'extension_ui_request', id: 'one', method: 'confirm', title: 'Allow?', message: 'rm' });
      send({ type: 'extension_ui_request', id: 'two', method: 'select', title: 'Pick', options: ['a', 'b'] });
      send({ type: 'extension_ui_request', id: 'three', method: 'notify', message: 'fyi' });
      setTimeout(() => {
        send({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(received) }] } });
        send({ type: 'agent_settled' });
      }, 100);
    `)),
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(JSON.parse(result.text), [
    { type: 'extension_ui_response', id: 'one', cancelled: true },
    { type: 'extension_ui_response', id: 'two', cancelled: true },
  ]);
  assert.ok(events.includes('extension_ui_request'), 'activity observers still see the request');
});
