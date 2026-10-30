import { join } from 'node:path';
import { openPiSession } from '../../src/cli/pi-session.mjs';

export function isolatePiHome(t, agentDir) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
}

/** Real SessionManager/resource loader; no provider, tools, private settings or network. */
export function fakePi(root, controls = new Map()) {
  const sessions = new Map();
  const opened = [];
  const dependencies = {
    agentDir: join(root, 'test-agent'),
    createSession: async ({ sessionManager, thinkingLevel, resourceLoader }) => {
      const id = sessionManager.getSessionId();
      const control = controls.get(id) ?? {};
      const listeners = new Set();
      const savedModel = sessionManager.buildSessionContext().model;
      let busy = false;
      control.aborted = false;

      const session = {
        sessionId: id,
        sessionFile: sessionManager.getSessionFile(),
        thinkingLevel,
        resourceLoader,
        model: control.model ?? {
          provider: savedModel?.provider ?? 'fixture',
          id: savedModel?.modelId ?? 'local',
        },
        get messages() { return sessionManager.buildSessionContext().messages; },
        getSessionStats() {
          return {
            sessionId: id,
            cost: this.messages.filter(message => message.role === 'assistant').length * 0.25,
          };
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async prompt(text, options = {}) {
          if (busy) throw Error('Concurrent fake SDK turn');
          busy = true;
          control.calls = (control.calls ?? 0) + 1;
          try {
            sessionManager.appendMessage({ role: 'user', content: text, timestamp: Date.now() });
            options.preflightResult?.(true);
            control.started?.resolve();
            await control.gate?.promise;
            if (control.aborted) throw Error('Aborted');
            sessionManager.appendMessage({
              role: 'assistant',
              content: [{ type: 'text', text: control.reply ?? `Reply: ${text}` }],
              timestamp: Date.now(),
              stopReason: 'stop',
              usage: { cost: { total: 0.25 } },
            });
            for (const listener of listeners) listener({ type: 'agent_settled' });
          } finally {
            busy = false;
          }
        },
        async sendCustomMessage(message, options) {
          sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
          if (options.triggerTurn) await this.prompt('Respond to the scheduled message.');
        },
        async abort() {
          control.aborted = true;
          control.gate?.resolve();
        },
        async bindExtensions() {},
        dispose() { control.disposed = true; },
      };
      controls.set(id, control);
      sessions.set(id, session);
      opened.push(id);
      return { session };
    },
  };
  return {
    controls,
    sessions,
    opened,
    dependencies,
    createMain: options => openPiSession(options, dependencies),
  };
}
