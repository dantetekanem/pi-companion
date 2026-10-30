import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { buildInvocation, runHarness } from '../src/cli/harnesses.mjs';

const id = 'f094b0ba-036c-4abc-9198-745fd1226765';
function request(t, harness = 'pi') {
  const cwd = mkdtempSync(join(tmpdir(), 'companion-harness-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return {
    id,
    harness,
    cwd,
    model: null,
    effort: 'medium',
    prompt: 'A quoted "request"\nwith context.',
    sessionFile: join(cwd, 'job.jsonl'),
  };
}
function fake(program, calls = []) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return spawn(process.execPath, ['--input-type=module', '-e', program], options);
  };
}
const restrictedPiFlags = [
  '--no-tools', '--no-builtin-tools', '--tools', '--exclude-tools',
  '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates',
  '--no-themes', '--no-context-files', '--no-approve', '--system-prompt',
];
function assertOrdinaryPiDefaults(args) {
  for (const flag of restrictedPiFlags) {
    assert.ok(!args.includes(flag), `${flag} should use Pi defaults`);
  }
  const appended = args.indexOf('--append-system-prompt');
  assert.ok(appended >= 0 && args[appended + 1].trim(), 'Companion instructions should extend the normal Pi prompt');
}
const rpc = (body, thinking = 'medium', model = { provider: 'test', id: 'model' }, statsResponse = "reply({ sessionId: 'pi-job', cost: 0.25, tokens: { input: 10, output: 5 } })") => `
let input = '';
const send = event => process.stdout.write(JSON.stringify(event) + '\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  let end;
  while ((end = input.indexOf('\\n')) >= 0) {
    const cmd = JSON.parse(input.slice(0, end));
    input = input.slice(end + 1);
    const reply = data => send({ type: 'response', id: cmd.id, command: cmd.type, success: true, data });
    if (cmd.type === 'get_state') {
      reply({ sessionId: 'pi-job', thinkingLevel: ${JSON.stringify(thinking)}, model: ${JSON.stringify(model)} });
    } else if (cmd.type === 'get_session_stats') {
      ${statsResponse};
    } else if (cmd.type === 'set_auto_retry' || cmd.type === 'set_auto_compaction') {
      reply();
    } else if (cmd.type === 'prompt') {
      reply({ disposition: 'started' });
      ${body}
    } else if (cmd.type === 'abort') {
      reply();
    }
  }
});
`;

test('harness argv keeps job identity controls and prompt text off the command line', t => {
  const pi = buildInvocation(request(t));
  assert.equal(pi.command, 'pi');
  assertOrdinaryPiDefaults(pi.args);
  assert.ok(!pi.args.includes('--model'));
  assert.equal(pi.args[pi.args.indexOf('--thinking') + 1], 'medium');
  assert.equal(pi.args[pi.args.indexOf('--mode') + 1], 'rpc');
  assert.ok(!pi.args.some(value => value.includes('quoted')));
  assert.throws(() => buildInvocation(request(t, 'claude')), /Pi/);
});

test('migrated delivery uses ordinary Pi defaults for compatibility checks', async t => {
  const input = { ...request(t), purpose: 'compatibility-check' };
  const invocation = buildInvocation(input);
  assertOrdinaryPiDefaults(invocation.args);
  assert.throws(() => buildInvocation({ ...input, harness: 'claude' }), /Pi/);
  const result = await runHarness(input, { spawnProcess: fake(rpc(`
    send({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Ordinary report' }] } });
    send({ type: 'agent_settled' });
  `)) });
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Ordinary report');
});

test('purpose-specific jobs keep their disabled tools and cannot change harness binding', t => {
  for (const purpose of ['migration-repair', 'reflection', 'session-patterns']) {
    const invocation = buildInvocation({ ...request(t), purpose });
    assert.ok(invocation.args.includes('--no-tools'));
    assert.ok(!invocation.args.includes('--tools'));
    assert.ok(invocation.args.includes('--no-extensions'));
    assert.ok(invocation.args.includes('--no-context-files'));
    assert.ok(invocation.args.includes('--no-approve'));
    assert.ok(invocation.args.includes('--system-prompt'));
    assert.throws(() => buildInvocation({ ...request(t, 'claude'), purpose }), /Pi/);
  }
  assert.throws(() => buildInvocation({ ...request(t), purpose: 'unknown' }), /purpose/);
});

test('Pi checks effective model and thinking before submission and returns session stats without counting streamed usage twice', async t => {
  const calls = [];
  const input = { ...request(t), model: 'test/model', effort: 'high' };
  const program = rpc(`
    send({
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Result \\u2028 Unicode' }],
        usage: { cost: { total: 0.25 } },
      },
    });
    send({ type: 'agent_end', messages: [] });
    send({ type: 'agent_settled' });
  `, 'high');
  const result = await runHarness(input, { spawnProcess: fake(program, calls) });
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Result \u2028 Unicode');
  assert.deepEqual(result.cost, { usd: 0.25, kind: 'estimate', cumulative: true, sessionId: 'pi-job' });
  assert.equal(result.model, 'test/model');
  assert.equal(result.effort, 'high');
  assert.equal(result.freshSession, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.shell, false);
  assertOrdinaryPiDefaults(calls[0].args);
  assert.equal(calls[0].args[calls[0].args.indexOf('--model') + 1], 'test/model');
  assert.equal(calls[0].args[calls[0].args.indexOf('--thinking') + 1], 'high');
});

test('Pi RPC extension errors fail the run without discarding the completed answer', async t => {
  const result = await runHarness(request(t), { spawnProcess: fake(rpc(`
    send({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Answer retained' }] } });
    send({ type: 'extension_error', extensionPath: '/extensions/example.ts', event: 'agent_end', error: 'handler failed' });
    send({ type: 'agent_settled', aborted: true });
  `)) });
  assert.equal(result.status, 'failed');
  assert.equal(result.text, 'Answer retained');
  assert.equal(result.error, 'handler failed');
});

test('Pi RPC aborted settlement without an extension error is interrupted, not completed', async t => {
  const result = await runHarness(request(t), { spawnProcess: fake(rpc(`
    send({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Answer retained' }] } });
    send({ type: 'agent_settled', aborted: true });
  `)) });
  assert.equal(result.status, 'interrupted');
  assert.equal(result.text, 'Answer retained');
  assert.match(result.error, /abort/i);
});

test('Pi keeps a completed answer when optional session statistics are rejected', async t => {
  const result = await runHarness(request(t), { spawnProcess: fake(rpc(`
    send({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Answer retained' }] } });
    send({ type: 'agent_settled' });
  `, 'medium', undefined, "send({ type: 'response', id: cmd.id, success: false, error: 'Statistics unavailable' })")) });
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Answer retained');
  assert.equal(result.cost, null);
});

test('Pi still rejects session statistics attributed to a different session', async t => {
  const result = await runHarness(request(t), { spawnProcess: fake(rpc(`
    send({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Answer retained' }] } });
    send({ type: 'agent_settled' });
  `, 'medium', undefined, "reply({ sessionId: 'other-session', cost: 0.25 })")) });
  assert.equal(result.status, 'failed');
  assert.equal(result.text, 'Answer retained');
  assert.equal(result.cost, null);
  assert.match(result.error, /identity/);
});

test('a clamped Pi effort fails before any prompt is submitted', async t => {
  const result = await runHarness(request(t), { spawnProcess: fake(rpc("process.stderr.write('PROMPT_WAS_SENT');", 'low')) });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /effort/);
  assert.doesNotMatch(result.error, /PROMPT_WAS_SENT/);
});

test('a mismatched Pi model fails before any prompt is submitted', async t => {
  const input = { ...request(t), model: 'test/requested' };
  const result = await runHarness(input, {
    spawnProcess: fake(rpc(
      "process.stderr.write('PROMPT_WAS_SENT');",
      'medium',
      { provider: 'test', id: 'effective' },
    )),
  });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /model/);
  assert.doesNotMatch(result.error, /PROMPT_WAS_SENT/);
});

test('Pi handled prompts fail without waiting for settlement and reap the owned child', { timeout: 3000 }, async t => {
  let child;
  t.after(() => { if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGKILL'); });
  const result = await runHarness(request(t), {
    spawnProcess: (...args) => {
      child = fake(rpc('').replace("reply({ disposition: 'started' });", "reply({ disposition: 'handled' });"))(...args);
      return child;
    },
  });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /Pi handled the prompt without starting an assistant response/);
  assert.equal(result.text, '');
  assert.equal(result.cost, null);
  assert.equal(result.noModel, undefined);
  assert.notEqual(child.signalCode ?? child.exitCode, null);
});

test('Pi accepts older prompt replies without a disposition', async t => {
  const result = await runHarness(request(t), { spawnProcess: fake(rpc(`
    send({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Older reply' }] } });
    send({ type: 'agent_settled' });
  `).replace("reply({ disposition: 'started' });", "reply();")) });
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Older reply');
});

test('missing, malformed, failed or oversized results never become zero-cost success', async t => {
  const failures = [
    "process.exit(0)",
    "console.log('{broken')",
    "process.stderr.write('denied');process.exit(2)",
    rpc("send({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', content: [] } }); send({ type: 'agent_settled' });"),
    "console.log('x'.repeat(1025))",
  ];
  for (const program of failures) {
    const result = await runHarness(request(t), { spawnProcess: fake(program), maxOutputBytes: 1024 });
    assert.equal(result.status, 'failed');
    assert.equal(result.cost, null);
    assert.ok(result.error);
  }
});

test('the output byte bound applies to each LF-delimited record, not to a long healthy stream', async t => {
  const longStream = fake(rpc(`
    for (let index = 0; index < 64; index++) {
      send({
        type: 'message_update',
        usage: { output: index },
        assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(64) },
      });
    }
    send({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Long report' }] } });
    send({ type: 'agent_settled' });
  `));
  const splitOversizedRecord = fake(rpc(`
    const record = JSON.stringify({ type: 'tool_execution_end', result: 'x'.repeat(1100) }) + '\\n';
    process.stdout.write(record.slice(0, 600));
    setTimeout(() => process.stdout.write(record.slice(600)), 20);
  `));

  const completed = await runHarness(request(t), { spawnProcess: longStream, maxOutputBytes: 1024 });
  const rejected = await runHarness(request(t), { spawnProcess: splitOversizedRecord, maxOutputBytes: 1024 });

  assert.equal(completed.status, 'completed');
  assert.equal(completed.text, 'Long report');
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.cost, null);
  assert.match(rejected.error, /record exceeded its byte limit/);
});

test('cancellation terminates the owned child and leaves unknown cost, without retry', async t => {
  const aborted = new AbortController();
  const calls = [];
  const result = await runHarness({ ...request(t), signal: aborted.signal }, {
    spawnProcess: fake("console.log(JSON.stringify({type:'system'}));setInterval(()=>{},1000)", calls),
    onEvent: () => aborted.abort(),
  });
  assert.equal(result.status, 'interrupted');
  assert.equal(result.cost, null);
  assert.equal(calls.length, 1);
});

test('a Pi job slower than an inherited saved timeout finishes naturally', async t => {
  const result = await runHarness({ ...request(t), timeoutMs: 20 }, { spawnProcess: fake(rpc(`
    setTimeout(() => {
      send({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Slow report' }] } });
      send({ type: 'agent_settled' });
    }, 200);
  `)) });
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Slow report');
});
