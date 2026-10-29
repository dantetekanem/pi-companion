import { mkdirSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { validateConfig } from '../config.mjs';
import { cadences } from '../schedules.mjs';
import { inventoryLegacy, legacyLayout, readSource } from './inventory.mjs';
import { installLegacyFence, collectShutdownReceipt, legacyControlRoot } from './fence.mjs';
import { validateOwnership } from './ownership.mjs';
import { inspectCheckpoint, importSessions } from './adoption.mjs';
import { importStates } from './state.mjs';
import { importArchives } from './archives.mjs';
import { importSchedules } from './schedules.mjs';
import { importBindings } from './bindings.mjs';
import { requestStateRepair, acceptStateRepair } from './repair.mjs';
import { fenceSchedules, verifyScheduleFence } from './scheduler.mjs';
import { assertRuntimeAdmission } from './admission.mjs';

function blocked(kind, diagnostics) {
  throw Object.assign(Error(`Migration ${kind} validation failed; no partial activation is permitted.`), { code: 'MIGRATION_BLOCKED', diagnostics });
}
function configFor(journal, input) {
  return validateConfig({ ...input, version: 2, initializedAt: journal.record.createdAt });
}
function assertPlan(journal, options) {
  const plan = journal.record.validation.plan;
  for (const key of ['sessions', 'decisions', 'overrides', 'reviewSettings']) if (options[key] !== undefined && !isDeepStrictEqual(options[key], plan[key])) throw Error('Validated migration plan changed after fencing.');
  if (options.config && !isDeepStrictEqual(configFor(journal, options.config), plan.requestedConfig ?? plan.config)) throw Error('Validated migration configuration changed after fencing.');
  return plan;
}
function verifyRemainingSources(journal) {
  const original = journal.record.manifest;
  const current = inventoryLegacy(original.spec);
  const comparable = manifest => ({
    spec: manifest.spec,
    files: manifest.files.filter(file => file.category !== 'scheduler'),
    directories: manifest.directories,
    missing: manifest.missing,
    references: manifest.references,
  });
  if (!isDeepStrictEqual(comparable(current), comparable(original))
    || current.files.some(file => file.category === 'scheduler') !== original.files.some(file => file.category === 'scheduler')) throw Error('Non-scheduler sources changed after staging; cutover is blocked.');
  for (const session of journal.record.validation.plan.sessions) readSource({ path: session.sessionFile, size: session.size, sha256: session.sha256 });
  if (journal.record.validation.plan.reviewSettings) readSource(journal.record.validation.plan.reviewSettings);
}
async function stageUpgrade(journal, options) {
  const record = journal.record;
  const sessions = options.sessions;
  if (!Array.isArray(sessions) || !sessions.length) throw Error('Explicit session pins are required for upgrade.');
  const requestedConfig = configFor(journal, options.config);
  let config = requestedConfig;
  const root = legacyLayout(record.manifest.spec.home).find(source => source.category === 'companion').path;
  const migration = {
    id: record.id,
    fingerprint: record.manifest.fingerprint,
    destination: journal.root,
    owners: sessions.map(({ sessionId, sessionFile }) => ({ sessionId, sessionFile })),
  };
  const legacyFence = { controlRoot: options.controlRoot ?? legacyControlRoot(root), migration, offline: options.offline ?? null };
  await installLegacyFence(root, migration, legacyFence);
  const quiescence = await collectShutdownReceipt(root, migration, legacyFence);
  await journal.stage();
  const checkpoint = await inspectCheckpoint(journal);
  const ownership = validateOwnership({ manifest: record.manifest, selection: record.selection, quiescence, checkpoint });
  if (config.main.cwd !== ownership.main.cwd) throw Error('Upgrade main cwd must match the explicitly selected saved conversation.');
  let overrides = options.overrides ?? [];
  if (options.repair?.approval) {
    const accepted = acceptStateRepair(journal, { ...options.repair.approval, otherOverrides: overrides });
    if (accepted.status !== 'accepted') blocked('repair', accepted.validation.errors);
    overrides = [...overrides, accepted.override];
  }
  const states = importStates(journal, { overrides });
  if (states.errors.length) {
    if (options.repair?.sourcePath) {
      const diagnostics = states.errors.filter(error => error.source?.path === options.repair.sourcePath);
      const repair = await requestStateRepair(journal, { ...options.repair, diagnostics });
      return { status: 'repair_review', migrationId: record.id, repair, errors: states.errors, overrides };
    }
    blocked('state', states.errors);
  }
  const histories = importSessions(journal, { ownership, sessions });
  const archives = importArchives(journal);
  const schedules = await importSchedules(journal, { ownership, states, sessions, decisions: options.decisions ?? [], engine: options.engine });
  if (schedules.errors.length) blocked('schedule', schedules.errors);
  const bindings = await importBindings(journal, { config, sessions, schedules, reviewSettings: options.reviewSettings });
  config = bindings.config;
  const artifacts = [...states.artifacts, ...histories.artifacts, ...archives.artifacts, ...schedules.artifacts, bindings.artifact];
  for (const cadence of cadences) mkdirSync(journal.dataPath(`schedules/${cadence}`), { recursive: true, mode: 0o700 });
  mkdirSync(journal.dataPath('notes'), { recursive: true, mode: 0o700 });
  artifacts.push(journal.writeData('schedules/README.md', readFileSync(new URL('../../prompts/schedule-setup.md', import.meta.url))));
  artifacts.push(journal.writeData('config.json', Buffer.from(`${JSON.stringify(config, null, 2)}\n`)));
  const plan = {
    sessions,
    decisions: options.decisions ?? [],
    config,
    requestedConfig,
    reviewSettings: options.reviewSettings ?? null,
    overrides,
  };
  journal.validate({
    fingerprint: record.manifest.fingerprint,
    ownership,
    legacyFence,
    plan,
    artifacts,
    scheduleIds: schedules.scheduleIds,
    validatedScheduleIds: schedules.validatedScheduleIds,
    errors: [],
  });
  return null;
}
function completed(journal) {
  journal.verifyActivation();
  const root = assertRuntimeAdmission(journal.root);
  const record = journal.record;
  return {
    status: 'verified',
    migrationId: record.id,
    root,
    scheduleCount: record.validation.scheduleIds.length,
    initializedAt: record.validation.plan.config.initializedAt,
  };
}

/** Called only for an explicitly authorized upgrade. It never starts a provider or service on its own. */
export async function runUpgrade(journal, options = {}) {
  journal.check();
  if (journal.record.phase === 'verified') return completed(journal);
  if (['inventory', 'staged'].includes(journal.record.phase)) {
    const pending = await stageUpgrade(journal, options);
    if (pending) return pending;
    journal.beginFence();
  }
  assertPlan(journal, options);
  const legacyFence = journal.record.validation.legacyFence;
  if (journal.record.phase === 'fencing') {
    const receipt = await fenceSchedules(journal, { ...legacyFence, failpoint: options.failpoint });
    verifyRemainingSources(journal);
    journal.fenced(receipt);
  }
  if (['fenced', 'committed'].includes(journal.record.phase)) {
    verifyRemainingSources(journal);
    await verifyScheduleFence(journal, legacyFence);
    if (journal.record.phase === 'fenced') journal.activate();
    return completed(journal);
  }
  throw Error('Unsupported migration phase; no automatic restart was attempted.');
}
