import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { migrationFixture } from './helpers/migration.mjs';
import { runUpgrade } from '../src/cli/migration/cutover.mjs';
import { sha256 } from '../src/cli/migration/inventory.mjs';
import { loadConfig } from '../src/cli/config.mjs';

test('missing or cross-provider execution bindings block migration before scheduler cutover', async t => {
  for (const mode of ['missing-session', 'missing-review', 'different-provider']) {
    const h = await migrationFixture(t);
    const id = h.options.sessions[0].sessionId;
    if (mode === 'missing-session') h.options.config.legacySessions = {};
    if (mode === 'missing-review') h.options.config.legacyReviews = {};
    if (mode === 'different-provider') h.options.config.legacyReviews[id].model = 'other/reviewer';
    await assert.rejects(runUpgrade(h.journal, h.options), /binding|provider/i);
    assert.equal(existsSync(join(h.root, 'active.json')), false);
    assert.equal(JSON.parse(readFileSync(h.schedulerFile, 'utf8')).revision, 4);
  }
});

test('a schedule-free selected main preserves its saved provider before cutover', async t => {
  for (const model of ['other/local', 'fixture/local']) {
    const h = await migrationFixture(t, {
      mutateState: state => { delete state.experience.wake; },
      mutateTasks(tasks, { selection }) {
        tasks.splice(0);
        appendFileSync(selection.sessionFile, JSON.stringify({
          type: 'model_change',
          id: 'model',
          parentId: null,
          timestamp: '2026-10-26T00:00:00Z',
          provider: 'fixture',
          modelId: 'local',
        }) + '\n');
      },
    });
    h.options.config.main.model = model;
    h.options.config.legacySessions = {};
    if (model === 'other/local') {
      await assert.rejects(runUpgrade(h.journal, h.options), /different provider/);
      assert.equal(existsSync(join(h.root, 'active.json')), false);
      assert.equal(JSON.parse(readFileSync(h.schedulerFile, 'utf8')).revision, 4);
    } else {
      const result = await runUpgrade(h.journal, h.options);
      assert.equal(result.status, 'verified');
      assert.equal(result.scheduleCount, 0);
      assert.equal(loadConfig(h.root).main.model, 'fixture/local');
    }
  }
});

test('explicit referenced review settings supply a pinned original binding; drift blocks activation', async t => {
  const references = [];
  let pin;
  const h = await migrationFixture(t, {
    references,
    mutateTasks(_tasks, { selection }) {
      const path = join(dirname(selection.sessionFile), 'review-settings.json');
      const bytes = Buffer.from(JSON.stringify({ favoriteModels: { 'read-critical': { model: 'fixture/reviewer', thinking: 'high' } } }));
      writeFileSync(path, bytes);
      pin = { path, size: bytes.length, sha256: sha256(bytes) };
      references.push({ kind: 'review-settings', path });
    },
  });
  delete h.options.config.legacyReviews;
  h.options.reviewSettings = pin;
  await assert.rejects(runUpgrade(h.journal, {
    ...h.options,
    failpoint: stage => {
      if (stage === 'scheduler-written') writeFileSync(pin.path, '{}');
    },
  }), /changed/);
  assert.equal(existsSync(join(h.root, 'active.json')), false);
  writeFileSync(pin.path, JSON.stringify({ favoriteModels: { 'read-critical': { model: 'fixture/reviewer', thinking: 'high' } } }));
  const result = await runUpgrade(h.journal, h.options);
  assert.equal(result.status, 'verified');
  assert.deepEqual(loadConfig(h.root).legacyReviews[h.options.sessions[0].sessionId], { model: 'fixture/reviewer', effort: 'high' });
  assert.ok(existsSync(join(result.root, 'imported/bindings.json')));
  assert.equal(JSON.parse(readFileSync(h.schedulerFile, 'utf8')).revision, 5);
});
