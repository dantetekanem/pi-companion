import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { BACKGROUND_CONTEXT, withCancel } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai';
import { createRegistry, defineDoc, defineExtension, defineTask, Harness, type TaskId } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';

export type CompanionOwner = { sessionId: string; sessionFile: string };
type Action = 'start' | 'stop';
type Lifecycle = {
  owner: CompanionOwner | null;
  active: boolean;
  setup: 'needed' | 'requested' | 'ready';
  taskId: TaskId<null> | null;
  action: Action | null;
};
type Checkpoint = { phase: 'daily' } | { phase: 'routines'; errors?: string[] };
export type CompanionControls = {
  // Both effects must reconcile their existing receipts before repeating an external action.
  daily(action: Action, signal: AbortSignal): Promise<void>;
  routines(action: Action, signal: AbortSignal): Promise<void>;
};
const LifecycleDoc = defineDoc<Lifecycle>({
  kind: 'companion.lifecycle',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ owner: null, active: false, setup: 'needed', taskId: null, action: null }),
});

/** Durable owns lifecycle tasks; Pi still owns model turns, tools, and scheduler execution. */
export class DurableCompanion {
  private harness!: Harness;
  private root!: Awaited<ReturnType<Harness['root']>>;
  private release!: () => Promise<void>;
  private closing?: Promise<void>;
  private controls?: CompanionControls;
  private admissions = Promise.resolve();
  private readonly waiter = withCancel(BACKGROUND_CONTEXT);
  private fault?: Error;
  private task = defineTask<Action, Checkpoint, null, Record<never, never>>({
    name: 'companion.control', version: 1,
    initial: () => ({ phase: 'daily' }),
    phases: {
      daily: async (task, runtime, context) => {
        const error = await this.applyControl(task.input, 'daily', runtime.signal);
        const errors = error === null ? [] : [error];
        await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'routines', errors } }), context);
      },
      routines: async (task, runtime, context) => {
        const errors = [...(task.state.checkpoint.errors ?? [])];
        const error = await this.applyControl(task.input, 'routines', runtime.signal);
        if (error !== null) errors.push(error);
        await runtime.commit(async tx => {
          (await tx.doc(LifecycleDoc, runtime.conversationId)).active = task.input === 'start';
          return {
            status: 'terminal',
            outcome: errors.length
              ? { status: 'failed', error: { message: errors.join('; ') } }
              : { status: 'completed', result: null },
          };
        }, context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context);
    },
  });

  private constructor() {}

  static async open(directory: string, owner: CompanionOwner, configured: boolean): Promise<DurableCompanion> {
    const instance = new DurableCompanion();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      instance.release = await lockfile.lock(directory, {
        retries: 0, stale: 300000, update: 10000,
        onCompromised: error => {
          instance.fault = error;
          void instance.close().catch(() => {});
        },
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOCKED') throw Error('Companion is already running in another Pi session. Resume it there.');
      throw error;
    }
    let storage;
    try {
      const file = join(directory, 'companion.sqlite');
      storage = await openNodeSqliteStorage(file);
      chmodSync(file, 0o600);
      const registry = createRegistry();
      registry.install(defineExtension({ name: 'companion', tasks: [instance.task] }));
      instance.harness = await Harness.open(storage, { models: createModels(), registry }, BACKGROUND_CONTEXT);
      instance.root = await instance.harness.root(BACKGROUND_CONTEXT, {
        init: async (tx, id) => {
          const state = await tx.doc(LifecycleDoc, id);
          state.owner = owner;
          state.setup = configured ? 'ready' : 'needed';
        },
      });
      if (!(await instance.state()).owner) throw Error('Companion has no saved owner; refusing to replace its state.');
      return instance;
    } catch (error) {
      if (instance.harness) await instance.harness.close(BACKGROUND_CONTEXT);
      else if (storage) await storage.close(BACKGROUND_CONTEXT);
      await instance.release();
      throw error;
    }
  }

  private check() {
    if (this.fault) throw this.fault;
    if (this.closing) throw Error('Companion runtime is closing.');
  }

  private async applyControl(action: Action, phase: keyof CompanionControls, signal: AbortSignal): Promise<string | null> {
    this.check();
    if (!this.controls) throw Error('Companion controls are unavailable.');
    let failure: string | null = null;
    try {
      await this.controls[phase](action, signal);
    } catch (error) {
      if (action === 'start') throw error;
      // A failed daily stop must not prevent pausing owned routines.
      failure = `${phase}: ${error instanceof Error ? error.message : String(error)}`;
    }
    signal.throwIfAborted();
    return failure;
  }

  async state(): Promise<Lifecycle> {
    this.check();
    const state = await this.harness.snapshot(LifecycleDoc, this.root.id, BACKGROUND_CONTEXT);
    if (!state) throw Error('Companion lifecycle checkpoint is missing.');
    return state;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const pending = this.admissions.catch(() => {}).then(() => {
      this.check();
      return operation();
    });
    this.admissions = pending;
    return pending;
  }

  private async wait(id: TaskId<null>) {
    const task = await this.harness.waitForTask(id, this.waiter.context);
    const outcome = task.state.outcome;
    if (outcome.status !== 'completed') {
      const reason = outcome.error?.message ?? outcome.reason ?? 'No completion receipt.';
      throw Error(`Companion control ${outcome.status}: ${reason}`);
    }
  }

  async control(action: Action, controls: CompanionControls): Promise<void> {
    let taskId: TaskId<null> | undefined;
    await this.enqueue(async () => {
      this.controls = controls;
      const state = await this.state();
      const previous = state.taskId === null ? undefined : await this.harness.getTask(state.taskId, BACKGROUND_CONTEXT);
      if (previous && previous.state.status !== 'terminal') {
        if (state.action === action) {
          taskId = previous.id;
          return;
        }
        await this.harness.abortTask(previous.id, BACKGROUND_CONTEXT);
        await this.harness.waitForTask(previous.id, this.waiter.context);
      }
      taskId = await this.root.commit(async tx => {
        const saved = await tx.doc(LifecycleDoc, this.root.id);
        const id = await tx.createTask(this.task, action, { ownership: { kind: 'conversation' } });
        saved.action = action;
        saved.taskId = id;
        return id;
      }, BACKGROUND_CONTEXT);
    });
    // Waiting outside admission lets a stop interrupt an active start.
    if (taskId !== undefined) await this.wait(taskId);
  }

  async recover(controls: CompanionControls): Promise<void> {
    let taskId: TaskId<null> | null = null;
    await this.enqueue(async () => {
      this.controls = controls;
      taskId = (await this.state()).taskId;
    });
    if (taskId !== null) await this.wait(taskId);
  }

  /** Reserve before dispatch: an uncertain external model submission must not be repeated. */
  async claimSetup(): Promise<boolean> {
    this.check();
    return this.root.commit(async tx => {
      const state = await tx.doc(LifecycleDoc, this.root.id);
      if (state.setup !== 'needed') return false;
      state.setup = 'requested';
      return true;
    }, BACKGROUND_CONTEXT);
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.waiter.cancel(new Error('Companion runtime closed.'));
      this.closing = this.harness.close(BACKGROUND_CONTEXT).then(() => this.release());
    }
    return this.closing;
  }
}
