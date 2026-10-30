import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { importedBinding } from './pi-session.mjs';
import { runHarness as defaultRunHarness } from './harnesses.mjs';
import { reportText } from './reports.mjs';

/** Delivery effects run only inside an already-admitted durable dispatch. */
export class SessionDelivery {
  constructor({ root, runtime, config, runHarness = defaultRunHarness }) {
    Object.assign(this, { root, runtime, config, runHarness });
    this.work = new Set();
    this.controllers = new Set();
    this.reservations = new Set();
    this.closed = false;
  }

  ready(sessionId) {
    return !this.closed && ![...this.reservations].some(token => token.sessionId === sessionId);
  }

  reserve(sessionId) {
    if (!this.ready(sessionId)) return null;
    const reservation = { sessionId, release: () => this.reservations.delete(reservation) };
    this.reservations.add(reservation);
    return reservation;
  }

  prompt(input) { return this.deliver(input, false); }
  message(input) { return this.deliver(input, true); }

  deliver(input, custom) {
    if (this.closed) return Promise.reject(Error('Conversation delivery is closed.'));
    const controller = new AbortController();
    this.controllers.add(controller);
    const operation = this.perform({
      ...input,
      signal: AbortSignal.any([controller.signal, ...(input.signal ? [input.signal] : [])]),
    }, custom);
    this.work.add(operation);
    return operation.finally(() => {
      this.work.delete(operation);
      this.controllers.delete(controller);
    });
  }

  async perform({ session: identity, text, signal, triggerTurn = true, reservation, onEvent }, custom) {
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 65536) throw Error('Scheduled message exceeds its text bounds.');
    const owned = reservation ?? this.reserve(identity.sessionId);
    if (!this.reservations.has(owned) || owned.sessionId !== identity.sessionId) {
      throw Error('Conversation is busy or its reservation is no longer valid.');
    }
    const release = reservation ? () => {} : owned.release;
    try {
      signal.throwIfAborted();
      if (custom && !triggerTurn) {
        return { status: 'completed', text: reportText(text), noModel: true, cost: null };
      }
      // Revalidate the imported provider binding on every turn; never resume its transcript.
      const binding = await importedBinding(this.root, identity.sessionId, this.config.legacySessions?.[identity.sessionId]);
      const index = JSON.parse(readFileSync(join(this.root, 'imported/sessions/index.json'), 'utf8'));
      const cwd = index.sessions.find(entry => entry.sessionId === identity.sessionId)?.cwd;
      if (typeof cwd !== 'string' || !isAbsolute(cwd) || !statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
        throw Error('Adopted session needs a valid mapped cwd directory.');
      }
      const directory = join(this.root, 'jobs');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      signal.throwIfAborted();
      const id = randomUUID();
      const result = await this.runHarness({
        id,
        harness: 'pi',
        purpose: 'compatibility-check',
        ...binding,
        cwd,
        prompt: text,
        sessionFile: join(directory, `${id}.jsonl`),
        signal,
      }, { onEvent });
      return { ...result, text: reportText(result.text) };
    } catch (error) {
      if (!signal.aborted) throw error;
      return { status: 'interrupted', error: String(error.message ?? error), cost: null, sessionId: null };
    } finally {
      release();
    }
  }

  close() {
    if (!this.closing) {
      this.closed = true;
      for (const controller of this.controllers) controller.abort(Error('Conversation delivery is closing.'));
      this.closing = Promise.allSettled([...this.work]);
    }
    return this.closing;
  }
}
