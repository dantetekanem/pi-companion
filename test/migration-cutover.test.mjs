import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../src/cli/migration/inventory.mjs';
import { migrationFixture as fixture } from './helpers/migration.mjs';
import { resolveDataRoot } from '../src/cli/migration/admission.mjs';
import { runUpgrade } from '../src/cli/migration/cutover.mjs';


test('complete upgrade preserves every source, imports every owned schedule and activates only once', async t => {
  const h = await fixture(t), result = await runUpgrade(h.journal, h.options);
  assert.equal(result.status, 'verified');
  assert.equal(result.scheduleCount, 3);
  assert.equal(resolveDataRoot(h.root), h.journal.dataRoot);
  const scheduler = JSON.parse(readFileSync(h.schedulerFile, 'utf8'));
  assert.equal(scheduler.unknown, 'preserve');
  assert.deepEqual(scheduler.tasks[3], h.tasks[3]);
  assert.ok(scheduler.tasks.slice(0, 3).every(task => task.enabled === false));
  const schedules = readdirSync(join(h.journal.dataRoot, 'schedules/compatibility')).map(file => JSON.parse(readFileSync(join(h.journal.dataRoot, 'schedules/compatibility', file))));
  assert.deepEqual(schedules.map(item => item.legacy).sort((a,b)=>a.id.localeCompare(b.id)), h.tasks.slice(0,3).sort((a,b)=>a.id.localeCompare(b.id)));
  for (const source of h.manifest.files) assert.equal(sha256(readFileSync(h.journal.sourcePath(source))), source.sha256);
  const before = readFileSync(h.schedulerFile, 'utf8');
  assert.deepEqual(await runUpgrade(h.journal, {}), result);
  assert.equal(readFileSync(h.schedulerFile, 'utf8'), before);
});

test('every durable boundary resumes under one migration identity without duplicate schedules or disable writes', async t => {
  for (const boundary of ['staged', 'fencing', 'scheduler-written', 'fenced', 'committed', 'verified']) {
    let failed = false;
    const failpoint = at => {
      if (at === boundary && !failed) {
        failed = true;
        throw Error(`crash:${at}`);
      }
    };
    const h = await fixture(t, { failpoint }), id = h.journal.record.id;
    await assert.rejects(runUpgrade(h.journal, { ...h.options, failpoint }), /crash:/);
    await h.journal.close();
    const resumed = await h.open();
    const result = await runUpgrade(resumed, h.options);
    assert.equal(result.status, 'verified');
    assert.equal(resumed.record.id, id);
    assert.equal(JSON.parse(readFileSync(h.schedulerFile, 'utf8')).revision, 5);
    assert.equal(readdirSync(join(resumed.dataRoot, 'schedules/compatibility')).length, 3);
  }
});

test('missing attribution and non-scheduler drift block all activation, not a partial successful import', async t => {
  const h = await fixture(t);
  await assert.rejects(runUpgrade(h.journal, { ...h.options, decisions: h.options.decisions.slice(0, 2) }), /schedule|attribution/);
  assert.equal(existsSync(join(h.root, 'active.json')), false);
  assert.deepEqual(JSON.parse(readFileSync(h.schedulerFile, 'utf8')).tasks, h.tasks);
  await assert.rejects(runUpgrade(h.journal, {
    ...h.options,
    failpoint: at => {
      if (at === 'scheduler-written') writeFileSync(join(h.home, '.companion-notes/nested/note.bin'), 'new source');
    },
  }), /changed|drift/);
  assert.equal(existsSync(join(h.root, 'active.json')), false);
});

test('a newly added task in a mapped session cannot slip between the scheduler write and activation', async t => {
  const h = await fixture(t);
  await assert.rejects(runUpgrade(h.journal, {
    ...h.options,
    failpoint: at => {
      if (at === 'scheduler-written') {
        const raw = JSON.parse(readFileSync(h.schedulerFile, 'utf8'));
        raw.tasks.push({ ...h.tasks[0], id: 'task_late' });
        writeFileSync(h.schedulerFile, JSON.stringify(raw));
      }
    },
  }), /unattributed|new.*schedule/i);
  assert.equal(existsSync(join(h.root, 'active.json')), false);
});

test('agent repair only proposes; exact reviewed approval still goes through every import and schedule check', async t => {
  const h = await fixture(t, { malformed: true }), source = h.manifest.files.find(file => file.category === 'state');
  let calls = 0;
  const requested = await runUpgrade(h.journal, {
    ...h.options,
    repair: {
      sourcePath: source.path,
      consent: { accepted: true, sourcePath: source.path, sourceSha256: source.sha256, binding: h.options.config.background },
      run: async () => {
        calls++;
        return {
          status: 'completed',
          sessionId: 'synthetic-repair',
          freshSession: true,
          cost: null,
          text: JSON.stringify({
            action: 'replace_state',
            sourceSha256: source.sha256,
            value: h.state,
            explanation: 'Synthetic repair, control state requires review.',
          }),
        };
      },
    },
  });
  assert.equal(requested.status, 'repair_review');
  assert.equal(existsSync(join(h.root, 'active.json')), false);
  const approval = { sourcePath: source.path, attemptId: requested.repair.attempt.id, proposalHash: requested.repair.proposalHash, confirmed: true, reviewedControl: true };
  const completed = await runUpgrade(h.journal, { ...h.options, repair: { approval } });
  assert.equal(completed.status, 'verified');
  assert.equal(calls, 1);
  assert.equal(readFileSync(h.stateFile, 'utf8'), '{ broken private');
  assert.equal(readFileSync(h.journal.sourcePath(source), 'utf8'), '{ broken private');
});
