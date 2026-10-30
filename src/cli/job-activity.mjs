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
  entries = [];
  message = 0;
  hidden = false;

  accept(event) {
    try {
      this.reduce(event);
    } catch {
      /* Display data must not fail execution. */
    }
  }

  text(index, value, append = false) {
    if (!Number.isInteger(index) || index < 0 || typeof value !== 'string') return;
    const id = `message:${this.message}:${index}`;
    let entry = this.entries.find(item => item.id === id);
    if (!entry) {
      entry = { id, kind: 'assistant', text: '' };
      this.entries.push(entry);
    }
    const previousText = append ? entry.text : '';
    entry.text = clean(previousText + clean(value));
  }

  tool(id, name, state, input, output) {
    if (typeof id !== 'string' || !id) return;
    const key = `tool:${id}`;
    let entry = this.entries.find(item => item.id === key);
    if (!entry) {
      if (typeof name !== 'string' || !name) return;
      entry = { id: key, kind: 'tool', name: clean(name), state };
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
          part?.type === 'text' && part.display !== false ? [`message:${this.message}:${index}`] : []));
        this.entries = this.entries.filter(entry =>
          !entry.id.startsWith(`message:${this.message}:`) || ids.has(entry.id));
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
    }
  }

  visibleMessage(message) {
    return message?.display !== false && (message?.role === 'assistant'
      || (message?.role === 'custom' && message.display === true));
  }

  snapshot() { return this.entries.map(entry => ({ ...entry })); }
}
