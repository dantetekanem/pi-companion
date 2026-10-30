import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrationFixture } from './helpers/migration.mjs';
import { planUpgrade, prepareUpgrade, applyUpgrade, upgradeStatus } from '../src/cli/migration/commands.mjs';
import { main } from '../src/cli/main.mjs';
import { MigrationJournal } from '../src/cli/migration/journal.mjs';
import { readLocalView } from '../src/cli/view.mjs';
import { legacyControlRoot, legacyIsFenced, LegacyOwner } from '../src/cli/migration/fence.mjs';
import { sha256 } from '../src/cli/migration/inventory.mjs';

const directory = process.env.COMPANION_TEST_SCHEDULER;
const realEngine = { skip: directory ? false : 'Set COMPANION_TEST_SCHEDULER to the installed 0.5.1 package.' };
async function fixture(t) {
  const h = await migrationFixture(t);
  await h.journal.close();
  rmSync(h.root, { recursive: true });
  const selection = {
    sourceHome: h.home,
    sessionFiles: h.options.sessions.map(session => session.sessionFile),
    mainSessionFile: h.options.sessions[0].sessionFile,
    config: h.options.config,
    decisions: h.options.decisions,
    schedulerPackage: directory,
  };
  return { ...h, selection };
}

test('read-only plan and explicit preparation precede a single resumable, source-preserving activation', realEngine, async t => {
  const h = await fixture(t), original = readFileSync(h.schedulerFile);
  const plan = planUpgrade(h.selection);
  assert.equal(existsSync(h.root), false);
  assert.deepEqual(readFileSync(h.schedulerFile), original);
  assert.equal(plan.candidates.length, 4);
  assert.equal(plan.options.decisions.length, 3);
  await assert.rejects(prepareUpgrade(h.root, plan, 'wrong'), /confirm/i);
  const prepared = await prepareUpgrade(h.root, plan, plan.hash);
  assert.equal(prepared.phase, 'inventory');
  assert.equal(existsSync(join(h.root, 'migration', prepared.migrationId, 'originals')), false);
  const staged = await MigrationJournal.open(h.root, plan.manifest, { selection: plan.selection });
  await staged.stage();
  staged.writeData('repairs/fixture.json', Buffer.from(JSON.stringify({ version: 1, binding: { harness: 'pi' }, attempts: [{
    id: 'repair-job', state: 'accepted', sessionId: 'repair-session', freshSession: true,
    cost: { usd: 0.3, sessionId: 'repair-session', kind: 'estimate', cumulative: true },
  }] })));
  await staged.close();
  const authorization = { offline: { ...h.options.offline, migrationId: prepared.migrationId } };
  await assert.rejects(applyUpgrade(h.root, { confirmation: 'wrong', authorization }), /confirm/i);
  await assert.rejects(applyUpgrade(h.root, {
    confirmation: prepared.migrationId,
    authorization,
    failpoint: phase => { if (phase === 'scheduler-written') throw Error('Synthetic stop'); },
  }), /Synthetic stop/);
  assert.equal(upgradeStatus(h.root).phase, 'fencing');
  const result = await applyUpgrade(h.root, { confirmation: prepared.migrationId, authorization });
  assert.equal(result.status, 'verified');
  const after = readFileSync(h.schedulerFile);
  assert.equal(JSON.parse(after).revision, 5);
  assert.deepEqual(await applyUpgrade(h.root, { confirmation: prepared.migrationId }), result);
  assert.deepEqual(readFileSync(h.schedulerFile), after);
  assert.equal(readFileSync(h.stateFile, 'utf8'), JSON.stringify(h.state));
  assert.equal(readLocalView(h.root).usage.usd, 0.3);
  const legacyRoot = join(h.home, '.pi/agent/companion');
  assert.equal(legacyIsFenced(legacyRoot), true);
  await assert.rejects(LegacyOwner.open(legacyRoot, plan.selection), /fenced/);
});

test('a home without scheduler records migrates without a compatibility engine, and its unscheduled wake does not block', async t => {
  const h = await fixture(t);
  const { schedulerPackage: _package, ...selection } = { ...h.selection, decisions: [] };
  assert.throws(() => planUpgrade(selection), /scheduler package/i);
  rmSync(join(h.home, '.pi/agent/state'), { recursive: true });
  const plan = planUpgrade(selection);
  assert.equal(plan.schedulerPackage, null);
  assert.equal(plan.engine, null);
  assert.deepEqual(plan.candidates, []);
  const prepared = await prepareUpgrade(h.root, plan, plan.hash);
  const authorization = { offline: { ...h.options.offline, migrationId: prepared.migrationId, fingerprint: prepared.fingerprint } };
  const result = await applyUpgrade(h.root, { confirmation: prepared.migrationId, authorization });
  assert.equal(result.status, 'verified');
  assert.equal(result.scheduleCount, 0);
  const index = JSON.parse(readFileSync(join(result.root, 'imported/schedules/index.json'), 'utf8'));
  assert.deepEqual(index.skippedWakes, [{ origin: h.options.sessions[0].origin, schedule: '24h' }]);
  assert.equal(readFileSync(h.stateFile, 'utf8'), JSON.stringify(h.state));
  assert.equal(legacyIsFenced(join(h.home, '.pi/agent/companion')), true);
});

test('CLI plan/status are finite and plain activation is rejected without staging or mutation', realEngine, async t => {
  const h = await fixture(t);
  const file = join(h.home, 'selection.json');
  writeFileSync(file, JSON.stringify(h.selection));
  const output = { text: '', write(value) { this.text += value; } };
  assert.equal(await main(['upgrade-plan', '--selection', file, '--home', h.root], output), 0);
  assert.equal(JSON.parse(output.text).version, 1);
  assert.equal(existsSync(h.root), false);
  await assert.rejects(main(['upgrade-apply', '--plain', '--home', h.root], output), /plain/i);
  assert.equal(existsSync(h.root), false);
});

test('public upgrade phases reject a noncanonical fence path before writing', realEngine, async t => {
  const h = await fixture(t);
  const legacyRoot = join(h.home, '.pi/agent/companion');
  const elsewhere = join(h.home, 'wrong-control');
  assert.throws(() => planUpgrade({ ...h.selection, controlRoot: elsewhere }), /canonical|control.*root/i);
  assert.equal(existsSync(elsewhere), false);
  assert.equal(existsSync(h.root), false);

  const plan = planUpgrade({ ...h.selection, controlRoot: legacyControlRoot(legacyRoot) });
  const { hash: _hash, ...payload } = structuredClone(plan);
  payload.options.controlRoot = elsewhere;
  const forged = { ...payload, hash: sha256(JSON.stringify(payload)) };
  await assert.rejects(prepareUpgrade(h.root, forged, forged.hash), /canonical|control.*root/i);
  assert.equal(existsSync(h.root), false);
  const prepared = await prepareUpgrade(h.root, plan, plan.hash);
  writeFileSync(join(h.root, 'migration/plan.json'), JSON.stringify(forged));
  await assert.rejects(applyUpgrade(h.root, { confirmation: prepared.migrationId }), /canonical|control.*root/i);
  assert.equal(existsSync(elsewhere), false);
  assert.equal(legacyIsFenced(legacyRoot), false);
});

test('source or plan changes require new review rather than rewriting a prepared plan', realEngine, async t => {
  const h = await fixture(t), plan = planUpgrade(h.selection);
  const edited = structuredClone(plan);
  edited.options.config.main.model = 'other/model';
  await assert.rejects(prepareUpgrade(h.root, edited, plan.hash), /hash|changed/i);
  await prepareUpgrade(h.root, plan, plan.hash);
  writeFileSync(h.stateFile, JSON.stringify({ ...h.state, started: false }));
  await assert.rejects(prepareUpgrade(h.root, plan, plan.hash), /changed/i);
});
