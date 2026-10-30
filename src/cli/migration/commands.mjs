import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { atomicJson, validateConfig } from '../config.mjs';
import { SchedulerCompatibility } from '../legacy-engine.mjs';
import { inventoryLegacy, legacyLayout, readSource, sha256, verifyInventory } from './inventory.mjs';
import { legacyControlRoot } from './fence.mjs';
import { pinSession } from './ownership.mjs';
import { MigrationJournal } from './journal.mjs';
import { runUpgrade } from './cutover.mjs';
import { UsageLedger } from '../usage.mjs';

export function readUpgradeJson(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > 67108864) throw Error('Upgrade input must be a bounded regular JSON file.');
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw Error('Invalid upgrade JSON.');
  }
}
const planHash = ({ hash, ...plan }) => sha256(JSON.stringify(plan));
function openEngine(plan) {
  const engine = plan.schedulerPackage == null ? null : SchedulerCompatibility.open(plan.schedulerPackage);
  if (!isDeepStrictEqual(engine?.identity ?? null, plan.engine)) throw Error('Compatibility engine changed since planning.');
  return engine;
}
const planFile = root => join(root, 'migration', 'plan.json');
const journalFile = root => join(root, 'migration', 'journal.json');

function canonicalControlRoot(home, selected) {
  const legacyRoot = legacyLayout(home).find(source => source.category === 'companion').path;
  const canonical = legacyControlRoot(legacyRoot);
  if (selected !== undefined && (typeof selected !== 'string' || !isAbsolute(selected) || resolve(selected) !== canonical)) {
    throw Error('Public upgrades require the canonical legacy control root.');
  }
  return canonical;
}

/** Read-only preparation evidence. Candidates are hints; only explicit decisions confer attribution. */
export function planUpgrade(input) {
  if (!Array.isArray(input.sessionFiles) || !input.sessionFiles.length || input.sessionFiles.length > 100
    || input.sessionFiles.some(file => !isAbsolute(file)) || !isAbsolute(input.mainSessionFile ?? '')) throw Error('Select explicit saved session files and a main session.');
  const sessions = input.sessionFiles.map(pinSession);
  const main = sessions.find(session => session.sessionFile === input.mainSessionFile);
  if (!main || new Set(sessions.map(session => session.sessionId)).size !== sessions.length) throw Error('Main selection or mapped session identity is ambiguous.');
  const controlRoot = canonicalControlRoot(input.sourceHome, input.controlRoot);
  const manifest = inventoryLegacy({ home: input.sourceHome, references: input.references ?? [] });
  const scheduler = manifest.files.find(file => file.category === 'scheduler');
  let tasks = [];
  if (scheduler) {
    let value;
    try {
      value = JSON.parse(readSource(scheduler).toString('utf8'));
    } catch {
      throw Error('Scheduler JSON must be reviewed before planning.');
    }
    tasks = Array.isArray(value) ? value : value.tasks;
    if (!Array.isArray(tasks)) throw Error('Scheduler task shape must be reviewed before planning.');
  }
  const engine = scheduler || input.schedulerPackage !== undefined ? SchedulerCompatibility.open(input.schedulerPackage) : null;
  const plan = {
    version: 1,
    manifest,
    selection: { sessionId: main.sessionId, sessionFile: main.sessionFile },
    schedulerPackage: input.schedulerPackage ?? null,
    engine: engine?.identity ?? null,
    candidates: tasks.map(task => ({
      taskId: task.id,
      sha256: sha256(JSON.stringify(task)),
      name: task.name ?? task.title ?? null,
      action: task.action,
      type: task.type,
      schedule: task.schedule,
      enabled: task.enabled,
      sessionFile: task.sessionFile,
      possibleOrigin: sessions.find(session => session.sessionFile === task.sessionFile)?.origin ?? null,
    })),
    options: {
      sessions,
      decisions: input.decisions ?? [],
      config: validateConfig(input.config),
      reviewSettings: input.reviewSettings ?? null,
      controlRoot,
    },
  };
  return { ...plan, hash: planHash(plan) };
}

export function upgradeStatus(root) {
  if (!existsSync(journalFile(root))) return { status: 'not_prepared' };
  const record = readUpgradeJson(journalFile(root));
  return {
    migrationId: record.id,
    phase: record.phase,
    fingerprint: record.manifest.fingerprint,
    owners: record.validation?.ownership?.owners ?? [],
    scheduleCount: record.validation?.scheduleIds?.length ?? null,
  };
}

export async function prepareUpgrade(root, plan, confirmation) {
  if (!confirmation || confirmation !== plan.hash) throw Error('Confirm the exact reviewed plan hash before preparing an upgrade.');
  if (plan.version !== 1 || planHash(plan) !== plan.hash) throw Error('Upgrade plan hash changed. Plan again.');
  canonicalControlRoot(plan.manifest.spec.home, plan.options.controlRoot);
  if (existsSync(join(root, 'config.json')) || existsSync(join(root, 'runtime'))) throw Error('Choose a new destination, not an initialized Companion home.');
  openEngine(plan);
  const existing = existsSync(planFile(root)) ? readUpgradeJson(planFile(root)) : null;
  if (existing && !isDeepStrictEqual(existing, plan)) throw Error('Prepared plan changed. Existing originals will not be replaced.');
  if (upgradeStatus(root).phase !== 'verified') verifyInventory(plan.manifest);
  const journal = await MigrationJournal.open(root, plan.manifest, { selection: plan.selection });
  try {
    if (!existing) atomicJson(planFile(root), plan, { exclusive: true });
    return upgradeStatus(root);
  } finally {
    await journal.close();
  }
}

function recordRepairCosts(journal) {
  const directory = join(journal.dataRoot, 'repairs');
  if (!existsSync(directory)) return;
  if (!lstatSync(directory).isDirectory()) throw Error('Repair records directory must be real.');
  const usage = UsageLedger.open(journal.dataRoot, journal.record.createdAt);
  for (const name of readdirSync(directory).filter(name => name.endsWith('.json'))) {
    const ledger = readUpgradeJson(join(directory, name));
    if (ledger.version !== 1 || ledger.binding?.harness !== 'pi' || !Array.isArray(ledger.attempts) || ledger.attempts.length > 3) throw Error('Invalid repair cost records.');
    for (const attempt of ledger.attempts) {
      usage.record({
        id: `repair:${attempt.id}`,
        harness: 'pi',
        sessionId: attempt.sessionId ?? null,
        status: ['running', 'interrupted'].includes(attempt.state) ? 'interrupted' : 'completed',
        freshSession: attempt.freshSession === true,
        cost: attempt.cost ?? null,
      });
    }
  }
}

/** Only this explicit command can fence sources and activate a prepared destination. */
export async function applyUpgrade(root, { confirmation, authorization = {}, failpoint } = {}) {
  const record = readUpgradeJson(journalFile(root));
  const plan = readUpgradeJson(planFile(root));
  if (confirmation !== record.id) throw Error('Confirm this prepared migration ID before applying it.');
  if (planHash(plan) !== plan.hash || plan.manifest.fingerprint !== record.manifest.fingerprint
    || !isDeepStrictEqual(plan.selection, record.selection)) throw Error('Prepared plan or journal identity changed.');
  canonicalControlRoot(plan.manifest.spec.home, plan.options.controlRoot);
  for (const key of Object.keys(authorization)) if (!['offline', 'repair', 'overrides'].includes(key)) throw Error(`Unknown upgrade authorization: ${key}`);
  if (authorization.repair) {
    for (const key of Object.keys(authorization.repair)) {
      if (!['sourcePath', 'consent', 'maxAttempts', 'retryOf', 'approval'].includes(key)) throw Error(`Unknown repair input: ${key}`);
    }
  }
  const engine = openEngine(plan);
  const journal = await MigrationJournal.open(root, plan.manifest, { selection: plan.selection });
  try {
    return await runUpgrade(journal, { ...plan.options, ...authorization, engine, failpoint });
  } finally {
    try {
      recordRepairCosts(journal);
    } finally {
      await journal.close();
    }
  }
}
