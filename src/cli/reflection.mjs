import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { curate, experienceContext } from '../reflection-core.mjs';
import { loadImportedHistory } from './history.mjs';
import { importedBinding } from './pi-session.mjs';
import { validateBinding } from './schedules.mjs';
import { runHarness as defaultRunHarness } from './harnesses.mjs';
import { reportText } from './reports.mjs';

const quiet = reason => ({ status: 'no_change', text: reason, noModel: true, cost: null });
function proposalText(result) {
  return reportText([
    ...result.decisions.map(item => `${item.action === 'ask' ? 'Question' : 'Proposal'}: ${item.proposal}\nSuccess signal: ${item.successSignal}\nEvidence: ${item.evidenceIds.join(', ')}`),
    ...result.lessons.map(item => `Lesson (${item.confidence}): ${item.text}\nEvidence: ${item.evidenceIds.join(', ')}`),
    ...result.assessments.map(item => `${item.taskId}: ${item.signal}. ${item.reason}\nEvidence: ${item.evidenceIds.join(', ')}`),
    ...result.answers.map(item => `Answer linked to ${item.questionId}: ${item.evidenceIds.join(', ')}`),
  ].join('\n\n'));
}

/** A separate no-tools review; it neither resumes a transcript nor applies schedule proposals. */
export class DailyReflection {
  constructor({ root, runtime, config, runHarness = defaultRunHarness, now = () => new Date() }) {
    Object.assign(this, { root, runtime, config, runHarness, now });
  }

  async memory(origin) {
    const state = await this.runtime.state();
    if (state.reflections?.[origin]) return state.reflections[origin];
    const source = loadImportedHistory(this.root).origins.find(item => item.origin === origin);
    if (!source) throw Error('No adopted origin for daily reflection.');
    const memory = JSON.parse(readFileSync(source.path, 'utf8')).legacy.experience;
    if (!memory) throw Error('No imported learning state for daily reflection.');
    await this.runtime.change(next => {
      next.reflections ??= {};
      next.reflections[origin] ??= memory;
    });
    return (await this.runtime.state()).reflections[origin];
  }

  async review({ session, origin, signal, onEvent }) {
    signal?.throwIfAborted();
    const initial = await this.memory(origin);
    const at = this.now().toISOString();
    const day = at.slice(0, 10);
    if (!initial.enabled) return quiet('Reflection is stopped.');
    if (initial.reviews.some(review => review.status === 'pending')) {
      throw Error('An earlier reflection is interrupted or uncertain; reconcile it before another review.');
    }
    if (initial.reviews.some(review => review.day === day)) return quiet('This day already has a review receipt.');
    const conversation = await importedBinding(this.root, session.sessionId, this.config.legacySessions?.[session.sessionId]);
    const binding = this.config.legacyReviews?.[session.sessionId];
    validateBinding({ harness: 'pi', ...binding });
    if (!binding?.model?.includes('/')) throw Error('Daily reflection needs its explicitly preserved review binding.');
    const provider = conversation.model.split('/')[0];
    if (binding.model.split('/')[0] !== provider) throw Error('Daily review cannot disclose evidence to a different provider.');
    const context = experienceContext(initial, provider);
    const visible = context.evidence.map(item => item.id);
    const id = randomUUID();
    const admitted = await this.runtime.change(next => {
      const memory = next.reflections[origin];
      if (!memory.enabled || memory.generation !== initial.generation) throw Error('Reflection stopped or changed before admission.');
      if (memory.reviews.some(review => review.day === day || review.status === 'pending')) return false;
      memory.reviews.push({
        id,
        day,
        at,
        status: 'pending',
        binding: { model: binding.model, thinking: binding.effort },
        evidenceIds: visible,
      });
      return true;
    });
    if (!admitted) return quiet('This review was already admitted.');
    let response;
    try {
      signal?.throwIfAborted();
      const jobs = join(this.root, 'jobs');
      mkdirSync(jobs, { recursive: true, mode: 0o700 });
      response = await this.runHarness({
        ...binding,
        id,
        harness: 'pi',
        purpose: 'reflection',
        cwd: session.cwd,
        sessionFile: join(jobs, `${id}.jsonl`),
        prompt: JSON.stringify(context),
        signal,
      }, { onEvent });
      if (response.status !== 'completed') throw Error(response.error ?? 'Daily reflection did not complete.');
      if (!response.text?.trim() || Buffer.byteLength(response.text) > 32000) {
        throw Error('Daily reflection returned empty or oversized output.');
      }
      let result;
      try {
        result = JSON.parse(response.text);
      } catch {
        throw Error('Daily reflection returned invalid JSON.');
      }
      signal?.throwIfAborted();
      await this.runtime.change(next => {
        const current = next.reflections[origin];
        if (!current.enabled || current.generation !== initial.generation) throw Error('Reflection stopped or changed during review.');
        const memory = JSON.parse(JSON.stringify(current));
        curate(memory, result, visible, at);
        for (const decision of result.decisions.filter(item => item.action === 'ask')) {
          if (memory.questions.some(question => question.id === decision.id)) continue;
          if (memory.evidence.some(evidence => evidence.id === decision.id)) {
            throw Error('Reflection question ID conflicts with existing evidence.');
          }
          memory.questions.push({
            id: decision.id,
            text: reportText(decision.proposal),
            at,
            status: 'open',
            answerIds: [],
          });
          memory.evidence.push({
            id: decision.id,
            text: reportText(decision.proposal),
            at,
            kind: 'question',
            provider,
            refs: decision.evidenceIds,
          });
        }
        Object.assign(memory.reviews.find(review => review.id === id), { status: 'completed', cost: response.cost?.usd });
        next.reflections[origin] = memory;
      });
      const text = proposalText(result);
      return { ...response, status: text ? 'completed' : 'no_change', text, proposals: result, origin, omittedHistory: context.omittedHistory };
    } catch (error) {
      const interrupted = signal?.aborted || !response || ['interrupted', 'incomplete'].includes(response.status);
      await this.runtime.change(next => {
        const review = next.reflections[origin].reviews.find(item => item.id === id);
        Object.assign(review, {
          status: interrupted ? 'pending' : 'failed',
          cost: response?.cost?.usd,
          error: String(error.message ?? error).slice(0, 500),
        });
      });
      return {
        ...response,
        status: interrupted ? 'interrupted' : 'failed',
        text: '',
        cost: response?.cost ?? null,
        error: String(error.message ?? error).slice(0, 500),
        origin,
      };
    }
  }
}
