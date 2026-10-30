import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { readSource, sha256 } from './inventory.mjs';

const signatureFields = ['name', 'action', 'type', 'schedule', 'scope', 'sessionFile', 'cwd', 'prompt', 'message', 'command', 'maxRuns', 'timeoutMs', 'wakeOn', 'followUpPrompt', 'successPrompt', 'failurePrompt'];
export const scheduleSignature = task => sha256(JSON.stringify(signatureFields.map(key => task[key])));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
function invalid(problem, code = 'invalid_schedule') {
  throw Object.assign(Error(problem), { code });
}
function requireValue(condition, problem, code) {
  if (!condition) invalid(problem, code);
}
function parse(bytes) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    invalid('Malformed preserved JSON; inspect the source privately.', 'invalid_json');
  }
}

function validateTask(task) {
  requireValue(/^task_[a-zA-Z0-9_]+$/.test(task.id ?? ''), 'Invalid scheduler identity.');
  requireValue(['once', 'interval', 'cron'].includes(task.type) && nonempty(task.schedule), 'Unsupported schedule type or missing cadence.');
  requireValue(['prompt', 'shell', 'notify', 'message'].includes(task.action), 'Unsupported action.');
  const payload = task.action === 'prompt' ? 'prompt' : task.action === 'shell' ? 'command' : 'message';
  requireValue(nonempty(task[payload]), `Missing ${payload}.`);
  requireValue(typeof task.enabled === 'boolean' && ['pending', 'running', 'fired', 'failed', 'cancelled', 'expired'].includes(task.status), 'Invalid enabled or execution state.');
  requireValue(Number.isSafeInteger(task.runCount) && task.runCount >= 0, 'Invalid persisted run count.');
  requireValue(!task.runOwner && task.status !== 'running' && !task.runAttemptId && !task.interruptedRun, 'A prior attempt is active or uncertain.', 'active_attempt');
  requireValue(timestamp(task.createdAt) && timestamp(task.dueAt), 'Missing or invalid creation/due timestamp.');
  for (const field of ['nextRun', 'expiresAt', 'disabledAt', 'cancelledAt']) if (task[field] !== undefined) requireValue(timestamp(task[field]), `Invalid ${field}.`);
  if (task.enabled && task.status === 'pending') requireValue(timestamp(task.nextRun), 'Enabled pending work needs its exact next occurrence.');
  if (task.maxRuns !== undefined) requireValue(Number.isSafeInteger(task.maxRuns) && task.maxRuns > 0, 'Invalid maxRuns.');
  if (task.timeoutMs !== undefined) requireValue(Number.isSafeInteger(task.timeoutMs) && task.timeoutMs >= 1000, 'Invalid timeoutMs.');
  if (task.cwd !== undefined) requireValue(isAbsolute(task.cwd), 'Invalid working directory.');
  if (task.triggerTurn !== undefined) requireValue(typeof task.triggerTurn === 'boolean', 'Invalid triggerTurn.');
  if (task.action === 'shell') {
    requireValue(task.wakeOn === undefined || ['always', 'success', 'failure', 'never', 'change'].includes(task.wakeOn), 'Invalid shell wake policy.');
    requireValue(task.stopOn === undefined || ['success', 'failure', 'never'].includes(task.stopOn), 'Invalid shell stop policy.');
  }
}
function loadSessionPins(sessions, ownership, origins) {
  requireValue(Array.isArray(sessions), 'Explicit saved-session pins are required.', 'session_mapping');
  const paths = new Map();
  const mapped = new Set();
  for (const session of sessions) {
    const header = parse(readSource({ ...session, path: session.sessionFile }).toString('utf8').split('\n', 1)[0]);
    requireValue(header.type === 'session' && header.id === session.sessionId && header.cwd === session.cwd
      && ownership.owners.includes(header.id) && session.origin === `session:${sha256(header.id)}` && !paths.has(session.sessionFile) && !mapped.has(session.origin), 'Saved-session pin or owner mapping changed.', 'session_mapping');
    paths.set(session.sessionFile, session);
    mapped.add(session.origin);
  }
  for (const origin of origins) requireValue(mapped.has(origin), 'Every state origin requires an explicit saved-session mapping.', 'session_mapping');
  return paths;
}
function loadStates(journal, states) {
  requireValue(states && Array.isArray(states.errors) && !states.errors.length, 'Every state must import successfully before schedules.', 'invalid_states');
  const values = new Map();
  for (const artifact of states.artifacts) {
    const bytes = readFileSync(journal.dataPath(artifact.path));
    requireValue(sha256(bytes) === artifact.sha256, 'Imported state changed.', 'changed_state');
    const wrapper = parse(bytes);
    requireValue(wrapper.origin === artifact.origin && !values.has(wrapper.origin), 'Invalid imported origin.', 'invalid_states');
    values.set(wrapper.origin, wrapper.legacy);
  }
  const expected = journal.record.manifest.files.filter(file => file.category === 'state').map(file => file.origin);
  requireValue(values.size === expected.length && expected.every(origin => values.has(origin)), 'Missing imported state origin.', 'invalid_states');
  return values;
}

/** Classifies every candidate using exact host decisions; never infers ownership from names alone. */
export async function importSchedules(journal, { ownership, states, sessions, decisions = [], engine } = {}) {
  const result = { artifacts: [], scheduleIds: [], validatedScheduleIds: [], errors: [] };
  const error = (taskId, failure) => result.errors.push({ taskId, code: failure.code ?? 'conversion_failed', problem: failure.message });
  const record = journal.record;
  try {
    requireValue(record.phase === 'staged', 'Schedule conversion requires staged originals.');
    journal.verifyArchive();
    requireValue(ownership?.fingerprint === record.manifest.fingerprint, 'Ownership scope changed.', 'ownership_scope');
    const origins = loadStates(journal, states);
    const mapped = loadSessionPins(sessions, ownership, origins.keys());
    const source = record.manifest.files.find(file => file.category === 'scheduler');
    const raw = source ? parse(readFileSync(journal.sourcePath(source))) : { version: 2, tasks: [] };
    requireValue(Array.isArray(raw) || (raw.version === 2 && Array.isArray(raw.tasks)), 'Unsupported scheduler container.', 'invalid_scheduler');
    const tasks = Array.isArray(raw) ? raw : raw.tasks;
    const byId = new Map();
    for (const task of tasks) {
      requireValue(object(task) && typeof task.id === 'string' && !byId.has(task.id), 'Malformed or duplicate raw scheduler record; no records were normalized.', 'invalid_scheduler');
      byId.set(task.id, task);
    }
    const selections = new Map();
    for (const decision of decisions) {
      const task = byId.get(decision.taskId);
      requireValue(task && !selections.has(decision.taskId) && decision.sha256 === sha256(JSON.stringify(task)), 'A selected task changed or was selected more than once.', 'changed_selection');
      requireValue(['companion', 'unrelated'].includes(decision.classification) && nonempty(decision.reason), 'Attribution needs an explicit classification and reason.', 'attribution_required');
      selections.set(decision.taskId, decision);
    }
    const linked = new Map();
    const skippedWakes = [];
    for (const [origin, state] of origins) {
      for (const receipt of state.stopping ?? []) {
        error(receipt.id, { code: 'stop_incomplete', message: `An unfinished stop in ${origin} must be reconciled before migration.` });
      }
      for (const receipt of [...state.paused, ...(state.stopping ?? [])]) {
        const task = byId.get(receipt.id);
        if (!task) {
          error(receipt.id, Object.assign(Error('A stored control receipt has no scheduler record.'), { code: 'missing_schedule' }));
          continue;
        }
        if (mapped.get(task.sessionFile)?.origin !== origin) {
          error(task.id, { code: 'session_mapping', message: `Control receipt in ${origin} does not match the task owner.` });
          continue;
        }
        linked.set(task.id, { origin, role: 'routine' });
      }
      const wake = state.experience?.wake;
      if (!wake) continue;
      // Without scheduler records, a saved wake was never scheduled; keep a trace instead of blocking.
      if (!source) {
        skippedWakes.push({ origin, schedule: wake.schedule ?? null });
        continue;
      }
      const candidates = tasks.filter(task => mapped.get(task.sessionFile)?.origin === origin
        && (wake.schedulerId ? task.id === wake.schedulerId : task.prompt === `companion-daily:${wake.token}`));
      if (candidates.length !== 1) {
        error(wake.schedulerId ?? null, Object.assign(Error('Daily-wake identity is missing or ambiguous.'), { code: 'missing_schedule' }));
        continue;
      }
      linked.set(candidates[0].id, { origin, role: 'daily-wake', wake });
    }
    const unrelatedIds = [];
    for (const task of tasks) {
      const session = mapped.get(task.sessionFile);
      const link = linked.get(task.id);
      const decision = selections.get(task.id);
      // Every task in a mapped session needs a decision, including tasks with an unlisted registry heading.
      if (!session && !link && !decision) {
        unrelatedIds.push(task.id);
        continue;
      }
      if (decision?.classification !== 'unrelated') result.scheduleIds.push(task.id);
      try {
        requireValue(decision, 'Explicit attribution is required; headings are only evidence.', 'attribution_required');
        requireValue(!link || decision.classification === 'companion', 'A Companion control or wake reference cannot be excluded.', 'owned_reference');
        if (decision.classification === 'unrelated') {
          unrelatedIds.push(task.id);
          continue;
        }
        requireValue(session && decision.origin === session.origin && (!link || link.origin === session.origin)
          && task.scope === 'session', 'Selected task does not match a pinned owner session.', 'session_mapping');
        const state = origins.get(session.origin);
        requireValue(state, 'Selected task has no preserved state origin.', 'session_mapping');
        requireValue(!(state.stopping ?? []).some(item => item.id === task.id), 'An unfinished stop must be reconciled before migration.', 'stop_incomplete');
        const pause = state.paused.find(item => item.id === task.id);
        requireValue(!pause || (pause.signature === scheduleSignature(task) && task.enabled === false && pause.disabledAt === task.disabledAt), 'Pause receipt no longer matches the exact task.', 'changed_receipt');
        if (link?.wake) requireValue(task.action === 'prompt' && task.type === 'interval' && task.schedule === link.wake.schedule
          && task.prompt === `companion-daily:${link.wake.token}`, 'Daily-wake configuration changed.', 'changed_receipt');
        validateTask(task);
        requireValue(nonempty(decision.timezone), 'Original scheduler timezone must be explicitly supplied.', 'timezone_required');
        new Intl.DateTimeFormat('en', { timeZone: decision.timezone }).format();
        let compatibility;
        try {
          requireValue(typeof engine?.validate === 'function', 'A pinned compatibility engine is required.');
          compatibility = await engine.validate(task, decision.timezone);
          requireValue(compatibility?.version === '0.5.1' && compatibility.timezone === decision.timezone, 'Compatibility validation identity changed.');
        } catch {
          invalid('The pinned engine could not validate this task; preserve it for repair.', 'engine_validation');
        }
        const id = `legacy-${sha256(`${source.path}\0${task.id}`).slice(0, 32)}`;
        const wrapper = {
          version: 1,
          id,
          origin: session.origin,
          role: link?.role ?? 'routine',
          session,
          source: { path: source.path, sha256: decision.sha256, taskId: task.id, storeSha256: source.sha256 },
          timezone: decision.timezone,
          compatibility,
          control: {
            started: state.started ?? null,
            paused: pause ?? null,
            experienceEnabled: state.experience?.enabled ?? null,
          },
          legacy: task,
        };
        result.artifacts.push({ ...journal.writeData(`schedules/compatibility/${id}.json`, Buffer.from(JSON.stringify(wrapper))), kind: 'schedule', taskId: task.id });
        result.validatedScheduleIds.push(task.id);
      } catch (failure) {
        error(task.id, failure);
      }
    }
    const index = {
      version: 1,
      source,
      decisions,
      unrelatedIds,
      scheduleIds: result.scheduleIds,
      validatedScheduleIds: result.validatedScheduleIds,
      skippedWakes,
      errors: result.errors,
    };
    result.artifacts.push({ ...journal.writeData('imported/schedules/index.json', Buffer.from(JSON.stringify(index)), { replace: true }), kind: 'index' });
  } catch (failure) {
    error(null, failure);
  }
  return result;
}
