import { BRIDGE, callBridge } from './bridge.mjs';
import { createMemoryTool, memorySection } from './memory.mjs';
import { createQuestionTool } from './questions.mjs';
import { createScheduleTool, createSettingsTool } from './companion-tools.mjs';

/**
 * Loaded with --extension by the Pi child that Companion starts for its main chat. The tools keep their
 * names, schemas and descriptions; each call runs in Companion, which owns the questions, schedules,
 * settings and memory. The model is Pi's, under whatever launcher started it.
 */
export default function companion(pi) {
  const tools = [createQuestionTool(), createScheduleTool(), createMemoryTool(), createSettingsTool()];
  for (const tool of tools) {
    pi.registerTool({
      ...tool,
      execute: (id, params, signal, _update, ctx) => callBridge(ctx, { op: 'tool', name: tool.name, id, params }, signal),
    });
  }
  pi.on('before_agent_start', async (event, ctx) => ({
    systemPrompt: `${event.systemPrompt}\n\n${memorySection(await callBridge(ctx, { op: 'memory' }))}`,
  }));
  // Session start runs before Pi reads its input, so this one record is a status update, never a dialog.
  pi.on('session_start', (_event, ctx) => {
    const names = tools.map(tool => tool.name);
    const missing = names.filter(name => !pi.getActiveTools().includes(name));
    if (missing.length) pi.setActiveTools([...pi.getActiveTools(), ...missing]);
    const active = pi.getActiveTools();
    ctx.ui.setStatus(BRIDGE, JSON.stringify({ version: 1, tools: names.filter(name => active.includes(name)) }));
  });
}
