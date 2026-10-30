import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai';
import { createRegistry, defineDoc, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { closePiSession, openPiSession, withPiCancellation } from './pi-session.mjs';
import { assertRuntimeAdmission } from './migration/admission.mjs';
import { saveReport } from './reports.mjs';
import { logRun } from './checks.mjs';

const context = BACKGROUND_CONTEXT;
const RuntimeDoc = defineDoc({
  kind: 'companion.v2.runtime',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ main: null, sessionBaselines: {}, runs: {}, lastTick: null }),
});
const copy = value => JSON.parse(JSON.stringify(value));
const costOf = session => {
  const stats = session.getSessionStats();
  return stats.sessionId === session.sessionId && Number.isFinite(stats.cost) && stats.cost >= 0
    ? { usd: stats.cost, kind: 'estimate', cumulative: true, sessionId: session.sessionId } : null;
};

export class CompanionRuntime {
  constructor(root, config, { createMain = openPiSession, askQuestion, triggerSchedule, onChange = () => {} } = {}) {
    this.directory = root;
    this.config = config;
    this.createMain = createMain;
    this.askQuestion = askQuestion;
    this.triggerSchedule = triggerSchedule;
    this.onChange = onChange;
    this.active = new Map();
    this.busySessions = new Set();
    this.mainTurn = null;
    this.resetting = false;
    this.closing = false;
    this.fault = null;
  }

  static async open(root, config, options) {
    root = assertRuntimeAdmission(root);
    const runtime = new CompanionRuntime(root, config, options);
    const directory = join(root, 'runtime');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      runtime.release = await lockfile.lock(directory, {
        retries: 0,
        stale: 300000,
        update: 10000,
        onCompromised: error => {
          runtime.fault = error;
          void runtime.close().catch(() => {});
        },
      });
    } catch (error) {
      if (error.code === 'ELOCKED') throw Error('Companion is already running for this home.');
      throw error;
    }
    let storage;
    try {
      const file = join(directory, 'companion.sqlite');
      storage = await openNodeSqliteStorage(file);
      chmodSync(file, 0o600);
      runtime.harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, context);
      runtime.root = await runtime.harness.root(context, {
        init: async (tx, id) => { await tx.doc(RuntimeDoc, id); },
      });
      const abandoned = await runtime.change(state => {
        const stopped = Object.values(state.runs).filter(run => run.status === 'running');
        for (const run of stopped) {
          Object.assign(run, {
            status: 'interrupted',
            cost: null,
            error: 'The previous owner stopped without a completion receipt. Not replayed.',
            finishedAt: new Date().toISOString(),
          });
        }
        return copy(stopped);
      });
      for (const run of abandoned) logRun(root, run);
      return runtime;
    } catch (error) {
      if (runtime.harness) await runtime.harness.close(context);
      else if (storage) await storage.close(context);
      await runtime.release();
      throw error;
    }
  }

  check() {
    if (this.fault) throw this.fault;
    if (this.closing) throw Error('Companion is closing.');
  }

  notify() {
    try {
      this.onChange();
    } catch {
      // UI observers cannot change a committed receipt.
    }
  }

  async state() {
    return copy(await this.harness.snapshot(RuntimeDoc, this.root.id, context));
  }

  async change(update) {
    const result = await this.root.commit(async tx => update(await tx.doc(RuntimeDoc, this.root.id)), context);
    this.notify();
    return result;
  }

  async connect() {
    this.check();
    if (!this.connecting) {
      this.connecting = this.connectMain().catch(error => {
        this.connecting = null;
        throw error;
      });
    }
    return this.connecting;
  }

  async connectMain(fresh = false) {
    const currentState = await this.state();
    const saved = fresh ? null : currentState.main;
    const main = await this.createMain({
      root: this.directory,
      config: this.config,
      saved,
      fresh,
      askQuestion: this.askQuestion,
      triggerSchedule: (scheduleId, callId, signal) => this.triggerSchedule(scheduleId, `${this.main.sessionId}:${callId}`, signal),
    });
    if (this.closing || this.fault) {
      await closePiSession(main);
      this.check();
    }
    if (!main.sessionId || !main.sessionFile
      || (saved && (saved.sessionId !== main.sessionId || saved.sessionFile !== main.sessionFile))) {
      await closePiSession(main);
      throw Error('Main Pi session identity is unavailable or changed.');
    }
    if (fresh && currentState.main
      && (currentState.main.sessionId === main.sessionId || currentState.main.sessionFile === main.sessionFile)) {
      await closePiSession(main);
      throw Error('A fresh main session must have a new identity and transcript.');
    }

    let unsubscribe;
    try {
      unsubscribe = main.subscribe(event => {
        if (event.type === 'compaction_end') {
          this.lastCompaction = {
            status: event.aborted ? 'cancelled' : event.errorMessage ? 'failed' : 'completed',
            reason: event.reason,
            at: new Date().toISOString(),
            error: event.errorMessage ?? null,
          };
        }
        this.notify();
      });
      await this.change(state => {
        if (fresh || !state.main) {
          if (state.main) {
            state.sessionBaselines ??= {};
            state.sessionBaselines[state.main.sessionId] = { baseline: state.main.baseline };
          }
          state.main = {
            sessionId: main.sessionId,
            sessionFile: main.sessionFile,
            connectedAt: new Date().toISOString(),
            baseline: costOf(main),
          };
        }
      });
    } catch (error) {
      unsubscribe?.();
      await closePiSession(main);
      throw error;
    }

    const previous = this.main;
    const unsubscribePrevious = this.unsubscribe;
    this.main = main;
    this.unsubscribe = unsubscribe;
    if (fresh) this.lastCompaction = null;
    unsubscribePrevious?.();
    if (previous && previous !== main) await closePiSession(previous);
    this.notify();
    return main;
  }

  contextInfo() {
    const entries = this.main?.sessionManager?.getBranch().filter(entry => entry.type === 'compaction');
    const last = entries?.at(-1);
    return {
      ...this.main?.getContextUsage?.(),
      auto: this.main?.autoCompactionEnabled ?? null,
      compacting: Boolean(this.main?.isCompacting),
      compactions: entries?.length ?? null,
      last: this.lastCompaction ?? (last ? { status: 'completed', at: last.timestamp } : null),
    };
  }

  messages() { return this.main?.messages ?? []; }
  get mainBusy() { return Boolean(this.main && this.busySessions.has(this.main.sessionId)); }
  sessionReady(sessionId) { return !this.closing && !this.fault && !this.busySessions.has(sessionId); }
  reserveSession(sessionId) {
    this.check();
    if (!sessionId || !this.sessionReady(sessionId)) throw Error('Conversation is busy.');
    this.busySessions.add(sessionId);
    this.notify();
    return () => {
      this.busySessions.delete(sessionId);
      this.notify();
    };
  }

  async reset() {
    this.check();
    if (!this.main) throw Error('Main conversation is not connected.');
    if (this.resetting) throw Error('Main conversation is already resetting.');

    const previous = this.main;
    const ownedTurn = this.mainTurn?.session === previous ? this.mainTurn : null;
    const hasBusyMainWork = this.mainBusy || previous.isStreaming;
    if (hasBusyMainWork && !ownedTurn) throw Error('Main conversation is busy.');

    this.resetting = true;
    this.notify();
    try {
      if (ownedTurn) {
        await Promise.allSettled([...ownedTurn.steering]);
        previous.clearQueue?.();
        this.active.get(ownedTurn.id)?.controller.abort();
        await previous.abort();
        await this.mainWork;
      }
      const main = await this.connectMain(true);
      this.connecting = Promise.resolve(main);
      return { sessionId: main.sessionId, sessionFile: main.sessionFile };
    } finally {
      this.resetting = false;
      this.notify();
    }
  }

  async admit(request) {
    this.check();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(request.id ?? '')
      || !['main', 'background', 'repair'].includes(request.kind)) {
      throw Error('Invalid dispatch identity.');
    }
    return this.change(state => {
      this.check();
      if (Object.hasOwn(state.runs, request.id)) return false;
      state.runs[request.id] = {
        ...copy(request),
        status: 'running',
        startedAt: new Date().toISOString(),
        cost: null,
      };
      return true;
    });
  }
  async finish(id, result) {
    if (!['completed', 'failed', 'interrupted', 'no_change', 'incomplete'].includes(result.status)) throw Error('Invalid completion status.');
    const finished = await this.change(state => {
      const run = state.runs[id];
      if (!run) throw Error('No dispatch admission exists.');
      if (run.status !== 'running') {
        if (JSON.stringify(run.result) !== JSON.stringify(result)) {
          throw Error('A conflicting receipt cannot replace a final outcome.');
        }
        return null;
      }
      if (run.kind !== 'main') {
        const report = result.text || result.error || 'No result text.';
        const failure = result.text && result.error ? `\n\n---\n\n**Execution failure:** ${result.error}` : '';
        saveReport(this.directory, id, `${report}${failure}`);
      }
      Object.assign(run, {
        status: result.status,
        cost: result.cost ?? null,
        result: copy(result),
        finishedAt: new Date().toISOString(),
      });
      return copy(run);
    });
    if (finished) logRun(this.directory, finished);
  }

  dispatch(request, effect, onAdmitted) {
    if (this.active.has(request.id)) return this.active.get(request.id).completion;
    const controller = new AbortController();
    const completion = Promise.resolve().then(async () => {
      if (!await this.admit(request)) return (await this.state()).runs[request.id];
      onAdmitted?.();
      let result;
      try {
        this.check();
        result = await effect(controller.signal);
      } catch (error) {
        result = {
          status: controller.signal.aborted ? 'interrupted' : 'failed',
          cost: null,
          error: String(error.message ?? error),
        };
      }
      await this.finish(request.id, result);
      return (await this.state()).runs[request.id];
    });
    this.active.set(request.id, { controller, completion });
    return completion.finally(() => this.active.delete(request.id));
  }

  async queueSteering(text, id, turn) {
    const request = {
      id,
      kind: 'main',
      title: 'Steering',
      prompt: text,
      harness: 'pi',
      sessionId: turn.sessionId,
      model: `${turn.session.model?.provider}/${turn.session.model?.id}`,
      effort: turn.session.thinkingLevel,
      parentRunId: turn.id,
    };
    let interruptedByReset = false;
    let admitted = false;
    const queued = Promise.resolve().then(async () => {
      try {
        if (!await this.admit(request)) {
          const existing = (await this.state()).runs[id];
          if (existing?.status === 'running' && existing.parentRunId === turn.id && existing.prompt === text) {
            return { id, queued: true };
          }
          throw Error('A dispatch with this identity already exists.');
        }
        admitted = true;
        this.check();
        interruptedByReset = this.resetting || this.mainTurn !== turn;
        if (interruptedByReset) throw Error('Main conversation is resetting.');
        if (this.main !== turn.session || !turn.session.isStreaming || typeof turn.session.steer !== 'function') {
          throw Error('Main conversation is busy.');
        }
        await turn.session.steer(text);
        turn.children.push(id);
        return { id, queued: true };
      } catch (error) {
        const existing = (await this.state()).runs[id];
        if (admitted && existing?.status === 'running' && existing.parentRunId === turn.id) {
          await this.finish(id, {
            status: interruptedByReset || this.resetting ? 'interrupted' : 'failed',
            cost: null,
            noModel: true,
            error: String(error.message ?? error),
          });
        }
        throw error;
      }
    });
    turn.steering.add(queued);
    try {
      return await queued;
    } finally {
      turn.steering.delete(queued);
    }
  }

  async finishSteering(turn, status) {
    if (!turn.children.length) return;
    return this.change(state => {
      const finishedAt = new Date().toISOString();
      for (const id of turn.children) {
        const run = state.runs[id];
        if (!run || run.status !== 'running') continue;
        Object.assign(run, {
          status,
          cost: null,
          result: { status, noModel: true },
          finishedAt,
        });
      }
    });
  }

  async send(text, id = randomUUID()) {
    this.check();
    if (!this.main) throw Error('Main conversation is not connected.');
    if (this.resetting) throw Error('Main conversation is resetting.');
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 65536) throw Error('Message must contain 1–65536 bytes.');

    const activeTurn = this.mainTurn;
    if (activeTurn?.session === this.main) {
      if (activeTurn.preflight && this.main.isStreaming && typeof this.main.steer === 'function') {
        return this.queueSteering(text, id, activeTurn);
      }
      if (this.mainBusy || this.main.isStreaming) throw Error('Main conversation is busy.');
      await this.mainWork;
      this.check();
      if (this.resetting) throw Error('Main conversation is resetting.');
      return this.send(text, id);
    }
    if (this.mainBusy || this.main.isStreaming) throw Error('Main conversation is busy.');

    const release = this.reserveSession(this.main.sessionId);
    const accepted = Promise.withResolvers();
    const session = this.main;
    const turn = {
      id,
      session,
      sessionId: session.sessionId,
      preflight: undefined,
      steering: new Set(),
      children: [],
    };
    this.mainTurn = turn;
    let preflight;
    let disposition;
    const work = this.dispatch({
      id,
      kind: 'main',
      title: 'Conversation',
      prompt: text,
      harness: 'pi',
      sessionId: session.sessionId,
      model: `${session.model?.provider}/${session.model?.id}`,
      effort: session.thinkingLevel,
    }, async signal => {
      try {
        await withPiCancellation(session, signal, () => session.prompt(text, {
          preflightResult: result => {
            disposition = result;
            preflight = result !== false;
            turn.preflight = preflight;
            if (signal.aborted) {
              // Throwing here bypasses Pi's settlement cleanup after it has started the run.
              void session.abort().catch(() => {});
              accepted.reject(signal.reason);
            } else if (preflight) {
              accepted.resolve({ id });
            } else {
              accepted.reject(Error('Message rejected before submission.'));
            }
          },
        }));
        if (disposition === 'handled') {
          return { status: 'completed', cost: costOf(session), text: '' };
        }
        if (disposition === 'queued') await session.waitForIdle();
        const last = session.messages.filter(message => message.role === 'assistant').at(-1);
        return {
          status: last?.stopReason === 'stop' ? 'completed' : 'incomplete',
          cost: costOf(session),
          text: last?.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? '',
        };
      } catch (error) {
        accepted.reject(error);
        return {
          status: signal.aborted || preflight === true ? 'interrupted' : 'failed',
          noModel: preflight === false,
          cost: preflight === false ? null : costOf(session),
          error: String(error.message ?? error),
        };
      }
    });
    this.mainWork = work.then(async run => {
      if (preflight === undefined) accepted.reject(Error('Message was already admitted or did not pass Pi preflight.'));
      await Promise.allSettled([...turn.steering]);
      await this.finishSteering(turn, run.status);
    }, error => {
      accepted.reject(error);
      this.fault = error;
    }).catch(error => {
      this.fault = error;
    }).finally(() => {
      if (this.mainTurn === turn) this.mainTurn = null;
      release();
    });
    return accepted.promise;
  }

  async cancel(id) {
    const active = this.active.get(id);
    if (!active) return;
    active.controller.abort();
    const run = (await this.state()).runs[id];
    if (run.kind === 'main') await this.main?.abort();
    await active.completion;
    if (run.kind === 'main') await this.mainWork;
  }

  async idle() {
    await this.mainWork;
    await Promise.all([...this.active.values()].map(item => item.completion));
  }

  close() {
    if (!this.closePromise) {
      this.closing = true;
      this.closePromise = (async () => {
        for (const { controller } of this.active.values()) controller.abort();
        await this.connecting?.catch(() => {});
        await this.main?.abort();
        await Promise.allSettled([this.mainWork, ...[...this.active.values()].map(item => item.completion)]);
        this.unsubscribe?.();
        await closePiSession(this.main);
        await this.harness.close(context);
        await this.release();
      })();
    }
    return this.closePromise;
  }
}
