import { stripVTControlCharacters } from 'node:util';

const clean = value => typeof value === 'string'
  ? stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '') : '';
const inputText = value => clean(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
// Only public content blocks, never result details or internal event records.
const outputText = value => {
  const content = Array.isArray(value) ? value : value?.content ?? value;
  if (typeof content === 'string') return clean(content);
  if (!Array.isArray(content)) return '';
  return content.filter(part => part?.type === 'text' && part.display !== false)
    .map(part => clean(part.text)).join('\n');
};

/** Allowlisted, disposable display data; never retains harness records. */
export class JobActivity {
  output = [];
  children = new Map();
  message = 0;
  hidden = false;

  constructor(root = null, runId = '', agentName = '') {
    this.root = root;
    this.prefix = runId ? `child:${JSON.stringify(runId)}:` : '';
    this.label = runId ? { agentName: clean(agentName) } : {};
  }

  get entries() { return this.root ? this.root.entries : this.output; }
  set entries(value) { if (this.root) this.root.entries = value; else this.output = value; }

  widget(event) {
    const prefix = 'pi-extended-teams:agent-output:v1:';
    if (
      event.method !== 'setWidget'
      || typeof event.widgetKey !== 'string'
      || !event.widgetKey.startsWith(prefix)
      || this.root
    ) return;

    const runId = event.widgetKey.slice(prefix.length);
    const lines = event.widgetLines;
    if (
      !runId || !Array.isArray(lines) || lines.length !== 5
      || !lines.every(value => typeof value === 'string')
    ) return;

    const [name, sequence, index, count, chunk] = lines;
    if (
      !name
      || !/^[1-9]\d*$/.test(sequence)
      || !/^(0|[1-9]\d*)$/.test(index)
      || !/^[1-9]\d*$/.test(count)
      || ![sequence, index, count].every(value => Number.isSafeInteger(Number(value)))
      || chunk.length > 16384
    ) return;
    const seq = Number(sequence);
    const position = Number(index);
    const total = Number(count);
    if (position >= total) return;

    let child = this.children.get(runId);
    if (!child) {
      child = new JobActivity(this, runId, name);
      child.sequence = 0;
      this.children.set(runId, child);
    }
    if (seq <= child.sequence) return;
    if (position === 0) child.pending = { seq, total, name, chunks: [] };
    const pending = child.pending;
    if (
      !pending || pending.seq !== seq || pending.total !== total
      || pending.name !== name || pending.chunks.length !== position
    ) return;
    pending.chunks.push(chunk);
    if (pending.chunks.length !== total) return;

    child.pending = null;
    const projected = JSON.parse(pending.chunks.join(''));
    child.sequence = seq;
    child.accept(projected);
  }

  accept(event) {
    try {
      if (event?.type === 'extension_ui_request') this.widget(event);
      else this.reduce(event);
    } catch {
      /* Display data must not fail execution. */
    }
  }

  text(index, value, append = false) {
    if (!Number.isInteger(index) || index < 0 || typeof value !== 'string') return;
    const id = `${this.prefix}message:${this.message}:${index}`;
    let entry = this.entries.find(item => item.id === id);
    if (!entry) {
      entry = { id, kind: 'assistant', text: '', ...this.label };
      this.entries.push(entry);
    }
    const previousText = append ? entry.text : '';
    entry.text = clean(previousText + clean(value));
  }

  tool(id, name, state, input, output) {
    if (typeof id !== 'string' || !id) return;
    const key = `${this.prefix}tool:${id}`;
    let entry = this.entries.find(item => item.id === key);
    if (!entry) {
      if (typeof name !== 'string' || !name) return;
      entry = { id: key, kind: 'tool', name: clean(name), state, ...this.label };
      this.entries.push(entry);
    }
    entry.state = state;
    if (input !== undefined) entry.input = inputText(input);
    if (output !== undefined) entry.output = outputText(output);
  }

  reduce(event) {
    if (!event || typeof event !== 'object') return;

    if (event.display === false) {
      if (event.type === 'message_start') {
        this.message++;
        this.hidden = true;
      } else if (event.type === 'message_update') {
        this.hidden = true;
      }
      return;
    }

    if (event.type === 'message_start') {
      this.message++;
      this.hidden = !this.visibleMessage(event.message);
    } else if (event.type === 'message_update') {
      const part = event.assistantMessageEvent;
      if (event.message?.display === false
        || part?.display === false
        || part?.content?.display === false) {
        this.hidden = true;
      }
      if (!this.hidden) {
        if (part?.type === 'text_delta') this.text(part.contentIndex, part.delta, true);
        if (part?.type === 'text_end') this.text(part.contentIndex, part.content);
      }
    } else if (event.type === 'message_end') {
      if (!this.hidden
        && this.visibleMessage(event.message)) {
        const content = typeof event.message.content === 'string' ? [{ type: 'text', text: event.message.content }] : event.message.content;
        if (!Array.isArray(content)) return;
        const ids = new Set(content.flatMap((part, index) =>
          part?.type === 'text' && part.display !== false ? [`${this.prefix}message:${this.message}:${index}`] : []));
        this.entries = this.entries.filter(entry =>
          !entry.id.startsWith(`${this.prefix}message:${this.message}:`) || ids.has(entry.id));
        content.forEach((part, index) => {
          if (part?.display === false) return;
          if (part?.type === 'text') this.text(index, part.text);
          if (part?.type === 'toolCall') this.tool(part.id, part.name, 'running', part.arguments);
        });
      }
      this.message++;
      this.hidden = false;
    } else if (['tool_execution_start', 'tool_execution_update'].includes(event.type)) {
      this.tool(event.toolCallId, event.toolName, 'running', event.args, event.partialResult);
    } else if (event.type === 'tool_execution_end') {
      this.tool(event.toolCallId, event.toolName, event.isError ? 'failed' : 'completed', undefined, event.result);
    } else if (['assistant', 'user'].includes(event.type)
      && event.message?.display !== false
      && Array.isArray(event.message?.content)) {
      this.message++;
      for (const [index, part] of event.message.content.entries()) {
        if (part?.display === false) continue;
        if (event.type === 'assistant' && part?.type === 'text') this.text(index, part.text);
        if (event.type === 'assistant' && part?.type === 'tool_use') this.tool(part.id, part.name, 'running', part.input);
        if (event.type === 'user' && part?.type === 'tool_result') this.tool(part.tool_use_id, null, part.is_error ? 'failed' : 'completed', undefined, part.content);
      }
    }
  }

  visibleMessage(message) {
    return message?.display !== false && (message?.role === 'assistant'
      || (message?.role === 'custom' && message.display === true));
  }

  snapshot() { return this.entries.map(entry => ({ ...entry })); }
}
