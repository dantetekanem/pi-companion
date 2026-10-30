import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { initialize } from '../src/cli/config.mjs';
import { openPiSession } from '../src/cli/pi-session.mjs';
import { CompanionRuntime } from '../src/cli/runtime.mjs';
import { isolatePiHome } from './helpers/pi-session.mjs';

// Real Pi discovery and tools, isolated from personal settings, MCP servers and providers.
test('main conversation uses Pi tools and MCP with native extension lifecycle', async t => {
  const root = mkdtempSync(join(tmpdir(), 'companion-capabilities-'));
  const agentDir = join(root, 'agent');
  isolatePiHome(t, agentDir);
  const extensions = join(agentDir, 'extensions');
  mkdirSync(extensions, { recursive: true });
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultTools: ['+codemode', '+tool_search'] }));
  const started = join(root, 'extension-started');
  writeFileSync(join(extensions, 'capability.js'), `
    import { appendFileSync } from 'node:fs';
    export default function (pi) {
      pi.registerTool({
        name: 'ordinary_capability', label: 'Ordinary configured tool',
        description: 'Returns fixture evidence.',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ content: [{ type: 'text', text: 'available' }], details: {} }),
      });
      pi.on('session_start', () => appendFileSync(${JSON.stringify(started)}, ${JSON.stringify('start\n')}));
      pi.on('session_shutdown', () => appendFileSync(${JSON.stringify(started)}, ${JSON.stringify('stop\n')}));
      pi.registerCommand('fixture-command', { handler: async () => {} });
    }
  `);
  const server = join(root, 'mcp-fixture.mjs');
  writeFileSync(server, String.raw`
    import { createInterface } from 'node:readline';
    createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      if (request.id === undefined) return;
      let result = {};
      if (request.method === 'initialize') result = {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' },
      };
      if (request.method === 'tools/list') result = {
        tools: [{ name: 'ping', description: 'Fixture ping', inputSchema: { type: 'object', properties: {} } }],
      };
      if (request.method === 'tools/call') result = { content: [{ type: 'text', text: 'fixture-pong' }] };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
    });
  `);
  writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({
    mcpServers: { fixture: { command: process.execPath, args: [server], exposure: 'codemode' } },
  }));
  const config = initialize(root, { cwd: root });
  const model = {
    id: 'local',
    name: 'Synthetic',
    provider: 'fixture',
    api: 'openai-completions',
    baseUrl: 'https://invalid.test',
    reasoning: true,
    input: ['text'],
    contextWindow: 32000,
    maxTokens: 2048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const modelRuntime = await ModelRuntime.create({
    authPath: join(root, 'auth.json'),
    modelsPath: null,
    modelsStorePath: join(root, 'models.json'),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.streamSimple = () => { throw Error('No provider call is allowed in this fixture'); };
  const runtime = await CompanionRuntime.open(root, config, {
    createMain: options => openPiSession(options, {
      agentDir,
      createSession: options => createAgentSession({ ...options, agentDir, modelRuntime, model }),
    }),
  });
  t.after(async () => {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  });
  const session = await runtime.connect();

  const activeTools = session.getActiveToolNames();
  for (const name of ['read', 'bash', 'edit', 'write', 'ordinary_capability', 'codemode', 'tool_search']) {
    assert.ok(activeTools.includes(name), `${name} should be available like normal Pi`);
  }
  assert.equal(readFileSync(started, 'utf8'), 'start\n');
  modelRuntime.checkAuth = async () => ({ available: true });
  modelRuntime.hasConfiguredAuth = () => false;
  session.agent.streamFunction = (_model, context) => {
    const answered = context.messages.at(-1).role === 'toolResult';
    const message = {
      role: 'assistant',
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: answered ? [{ type: 'text', text: 'MCP check finished.' }] : [{
        type: 'toolCall', id: 'mcp-fixture', name: 'codemode',
        arguments: { code: 'text(await tools.mcp__fixture__ping({}));' },
      }],
      stopReason: answered ? 'stop' : 'toolUse',
      timestamp: Date.now(),
      usage: {
        input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: 'done', reason: message.stopReason, message });
      stream.end();
    });
    return stream;
  };
  await runtime.send('Call the fixture MCP through codemode.', 'mcp');
  await runtime.idle();
  const reply = session.messages.find(message => message.role === 'toolResult' && message.toolName === 'codemode');
  assert.ok(reply, 'the synthetic model issued the codemode call');
  assert.notEqual(reply.isError, true, JSON.stringify(reply.content));
  assert.match(JSON.stringify(reply.content), /fixture-pong/);

  await runtime.send('/fixture-command', 'command');
  await runtime.idle();
  assert.equal((await runtime.state()).runs.command.status, 'completed');
  assert.equal((await runtime.state()).runs.command.result.text, '');

  const report = join(root, 'authorized-fixture-report.md');
  writeFileSync(report, '# Temporary report\n');
  const bash = session.agent.state.tools.find(tool => tool.name === 'bash');
  await bash.execute('remove-fixture-report', { command: `rm -- ${JSON.stringify(report)}` }, new AbortController().signal);
  assert.equal(existsSync(report), false, 'ordinary Pi shell can carry out an authorized file operation');

  await runtime.reset();
  assert.equal(readFileSync(started, 'utf8'), 'start\nstart\nstop\n');
  await runtime.close();
  assert.equal(readFileSync(started, 'utf8'), 'start\nstart\nstop\nstop\n');
});
