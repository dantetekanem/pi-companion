import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { migrationFixture } from './helpers/migration.mjs';
import { runUpgrade } from '../src/cli/migration/cutover.mjs';
import { CompanionRuntime } from '../src/cli/runtime.mjs';
import { DailyReflection } from '../src/cli/reflection.mjs';
import { UsageLedger } from '../src/cli/usage.mjs';
import { loadConfig } from '../src/cli/config.mjs';
import { experienceContext } from '../src/reflection-core.mjs';

const at = '2026-10-28T00:00:00Z';
const proposal = {
  assessments: [],
  lessons: [{
    id: 'short',
    action: 'upsert',
    text: 'Keep reports short.',
    confidence: 'supported',
    evidenceIds: ['user'],
  }],
  decisions: [{
    id: 'weekly',
    action: 'ask',
    proposal: 'Would a weekly summary help?',
    successSignal: 'The user chooses a time.',
    evidenceIds: ['user'],
  }],
  answers: [],
};
async function fixture(t, run) {
  const h = await migrationFixture(t, {
    mutateState(state) {
      state.experience.evidence.push(
        { id: 'user', kind: 'user', text: 'Short reports help.', provider: 'fixture', at },
        { id: 'private', kind: 'user', text: 'Do not disclose this provider.', provider: 'other', at },
      );
    },
  });
  await runUpgrade(h.journal, h.options);
  const session = h.options.sessions[0];
  const config = {
    ...loadConfig(h.root),
    legacySessions: { [session.sessionId]: { model: 'fixture/local', effort: 'medium' } },
    legacyReviews: { [session.sessionId]: { model: 'fixture/reviewer', effort: 'high' } },
  };
  const runtime = await CompanionRuntime.open(h.root, config);
  const reflection = new DailyReflection({ root: runtime.directory, runtime, config, runHarness: run, now: () => new Date(at) });
  t.after(() => runtime.close());
  return {
    ...h,
    config,
    runtime,
    reflection,
    input: {
      session,
      origin: session.origin,
      task: { id: 'task_wake' },
      signal: new AbortController().signal,
    },
  };
}

test('bounded reflection context reports omitted permitted history even when the byte limit is not reached', () => {
  const state = {
    evidence: Array.from({ length: 81 }, (_, i) => ({ id: `e${i}`, kind: 'user', provider: 'fixture', text: 'short' })),
    questions: [],
    lessons: [],
    decisions: [],
    assessments: [],
  };

  const context = experienceContext(state, 'fixture');

  assert.equal(context.evidence.length, 80);
  assert.equal(context.omittedHistory, true);
});

test('daily reflection submits only bounded same-provider evidence without tools, saves proposals once and keeps imported state unchanged', async t => {
  let calls = 0;
  const h = await fixture(t, async request => {
    calls++;
    assert.equal(request.purpose, 'reflection');
    assert.equal(request.model, 'fixture/reviewer');
    assert.equal(request.effort, 'high');
    assert.equal(request.harness, 'pi');
    const context = JSON.parse(request.prompt);
    assert.deepEqual(context.evidence.map(item => item.id), ['user']);
    return {
      status: 'completed',
      sessionId: request.id,
      freshSession: true,
      cost: { usd: 0.2, sessionId: request.id, kind: 'estimate', cumulative: true },
      text: JSON.stringify(proposal),
    };
  });
  const source = readFileSync(h.stateFile);
  const receipt = await h.runtime.dispatch({ id: 'review-1', kind: 'background', harness: 'pi' }, signal => h.reflection.review({ ...h.input, signal }));
  assert.equal(receipt.status, 'completed', JSON.stringify(receipt.result));
  assert.equal(receipt.result.proposals.decisions[0].action, 'ask');
  const state = await h.runtime.state();
  const memory = state.reflections[h.input.origin];
  assert.equal(memory.lessons[0].id, 'short');
  assert.equal(memory.questions[0].id, 'weekly');
  assert.equal(memory.questions[0].status, 'open');
  assert.equal(memory.decisions[0].appliedEvidenceIds, undefined);
  assert.equal(UsageLedger.open(h.runtime.directory, h.config.initializedAt).sync(state).usd, 0.2);
  assert.equal((await h.reflection.review(h.input)).status, 'no_change');
  assert.equal(calls, 1);
  assert.deepEqual(readFileSync(h.stateFile), source);
});

test('reflection forwards its activity observer without changing review output', async t => {
  const events = [];
  const h = await fixture(t, async (_request, { onEvent }) => {
    onEvent({ type: 'message_start' });
    return { status: 'completed', text: JSON.stringify(proposal), cost: { usd: 0 } };
  });
  const result = await h.reflection.review({ ...h.input, onEvent: event => events.push(event) });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.deepEqual(events, [{ type: 'message_start' }]);
});

test('invalid evidence and fabricated feedback fail ordinary curation, keep cost, and cannot be retried that day', async t => {
  let calls = 0;
  const h = await fixture(t, async request => {
    calls++;
    return {
      status: 'completed',
      sessionId: request.id,
      freshSession: true,
      cost: { usd: 0.1, sessionId: request.id, kind: 'estimate', cumulative: true },
      text: JSON.stringify({ ...proposal, lessons: [{ ...proposal.lessons[0], evidenceIds: ['private'] }] }),
    };
  });
  const result = await h.reflection.review(h.input);
  assert.equal(result.status, 'failed');
  assert.equal(result.cost.usd, 0.1);
  assert.match(result.error, /visible|evidence/);
  assert.equal((await h.runtime.state()).reflections[h.input.origin].lessons.length, 0);
  assert.equal((await h.reflection.review(h.input)).status, 'no_change');
  assert.equal(calls, 1);
});

test('review binding and stop state block disclosure, while interrupted admitted attempts stay unreplayed', async t => {
  let calls = 0;
  const h = await fixture(t, async request => {
    calls++;
    return {
      status: 'interrupted',
      sessionId: request.id,
      freshSession: true,
      cost: null,
      error: 'Synthetic interruption',
    };
  });
  h.config.legacyReviews[h.input.session.sessionId].model = 'other/reviewer';
  await assert.rejects(h.reflection.review(h.input), /provider/);
  assert.equal(calls, 0);
  h.config.legacyReviews[h.input.session.sessionId].model = 'fixture/reviewer';
  const result = await h.reflection.review(h.input);
  assert.equal(result.status, 'interrupted');
  await assert.rejects(h.reflection.review(h.input), /interrupted|uncertain/);
  assert.equal(calls, 1);

  await h.runtime.change(state => { state.reflections[h.input.origin].enabled = false; });
  assert.equal((await h.reflection.review(h.input)).status, 'no_change');
  assert.equal(calls, 1);
});
