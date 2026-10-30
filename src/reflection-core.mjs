import { isDeepStrictEqual } from 'node:util';
import { Type } from 'typebox';
import { Check } from 'typebox/value';

const id = () => Type.String({ pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$' });
const text = () => Type.String({ minLength: 1, maxLength: 2000, pattern: '^[^\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f]+$' });
const ids = () => Type.Array(id(), { minItems: 1, maxItems: 12, uniqueItems: true });
const values = items => Type.Unsafe({ type: 'string', enum: items });
const object = fields => Type.Object(fields, { additionalProperties: false });
export const ReflectionSchema = object({
  assessments: Type.Array(object({
    taskId: id(),
    signal: values(['helpful', 'dismissed', 'completed', 'no_observed_response', 'unknown']),
    basis: values(['explicit', 'observed', 'inferred']),
    reason: text(),
    evidenceIds: ids(),
  }), { maxItems: 10 }),
  lessons: Type.Array(object({
    id: id(),
    action: values(['upsert', 'remove']),
    text: text(),
    confidence: values(['tentative', 'supported']),
    evidenceIds: ids(),
  }), { maxItems: 5 }),
  decisions: Type.Array(object({
    id: id(),
    action: values(['create', 'revise', 'pause', 'retire', 'ask']),
    taskId: Type.Optional(id()),
    proposal: text(),
    successSignal: text(),
    evidenceIds: ids(),
  }), { maxItems: 5 }),
  answers: Type.Array(object({ questionId: id(), evidenceIds: ids() }), { maxItems: 5 }),
});

/** @param {import('./experience.ts').Experience} state @param {string[]} ids @param {string[]} [visible] */
export function references(state, ids, visible) {
  return ids.map(id => {
    const evidence = state.evidence.find(item => item.id === id);
    if (!evidence || (visible && !visible.includes(id))) throw Error(`Unknown or non-visible evidence: ${id}`);
    return evidence;
  });
}
/** @param {import('./experience.ts').Experience} state @param {string} questionId @param {string[]} evidenceIds @param {string[]} [visible] */
export function answer(state, questionId, evidenceIds, visible) {
  const question = state.questions.find(item => item.id === questionId);
  if (!question) throw Error('Unknown question.');
  if (!references(state, evidenceIds, visible).every(item => item.kind === 'user')) {
    throw Error('Answers require recorded user evidence, not agent guesses.');
  }
  question.status = 'answered';
  question.answerIds = [...new Set([...question.answerIds, ...evidenceIds])];
}
/** @param {import('./experience.ts').Experience} state @param {import('./experience.ts').Reflection} result @param {string[]} visibleIds */
export function curate(state, result, visibleIds, at = new Date().toISOString()) {
  if (!Check(ReflectionSchema, result)) throw Error('Invalid reflection output.');
  for (const item of result.assessments) {
    const evidence = references(state, item.evidenceIds, visibleIds);
    if (item.basis === 'explicit' && !evidence.some(source => source.kind === 'user')) {
      throw Error('Explicit feedback requires user evidence.');
    }
    if (['helpful', 'dismissed', 'completed'].includes(item.signal) && !evidence.some(source => ['user', 'outcome'].includes(source.kind))) {
      throw Error('Usefulness needs feedback or an outcome, not delivery or silence.');
    }
    state.assessments.push({ ...item, at });
  }
  for (const item of result.lessons) {
    const evidence = references(state, item.evidenceIds, visibleIds);
    if (item.confidence === 'supported' && !evidence.some(source => ['user', 'outcome'].includes(source.kind))) {
      throw Error('Supported lessons require feedback or outcomes.');
    }
    const previous = state.lessons.findLast(lesson => lesson.id === item.id);
    if (!previous || !isDeepStrictEqual({ ...previous, at }, { ...item, at })) {
      state.lessons.push({ ...item, at });
    }
  }
  for (const item of result.decisions) {
    references(state, item.evidenceIds, visibleIds);
    if (!['create', 'ask'].includes(item.action) && !item.taskId) throw Error('Schedule changes require a task identity.');
    const previous = state.decisions.find(decision => decision.id === item.id);
    if (previous) {
      const { at: _at, appliedEvidenceIds: _applied, ...saved } = previous;
      if (!isDeepStrictEqual(saved, item)) throw Error('Decision ID conflicts with a previous decision.');
    } else state.decisions.push({ ...item, at });
  }
  for (const item of result.answers) {
    answer(state, item.questionId, item.evidenceIds, visibleIds);
  }
}
/** @param {import('./experience.ts').Experience} state */
export function view(state) {
  const latest = new Map(state.lessons.map(item => [item.id, item]));
  return {
    evidence: state.evidence,
    questions: state.questions,
    lessons: [...latest.values()].filter(item => item.action !== 'remove'),
    decisions: state.decisions.filter(item => !item.appliedEvidenceIds),
    appliedDecisions: state.decisions.filter(item => item.appliedEvidenceIds),
    assessments: state.assessments.slice(-20),
  };
}
/** @param {import('./experience.ts').Experience} state @param {string} provider */
export function experienceContext(state, provider, maxBytes = 32000) {
  const memory = view(state);
  const permitted = new Set(state.evidence.filter(item => item.provider === provider).map(item => item.id));
  const withinProvider = item => item.evidenceIds.every(id => permitted.has(id));
  let omittedHistory = false;
  const take = (items, limit) => {
    if (items.length > limit) omittedHistory = true;
    return items.slice(-limit);
  };
  const context = {
    evidence: take(memory.evidence.filter(item => permitted.has(item.id)), 80),
    questions: take(memory.questions.filter(item => permitted.has(item.id)), 12),
    lessons: take(memory.lessons.filter(withinProvider), 12),
    decisions: take(memory.decisions.filter(withinProvider), 10),
    appliedDecisions: take(memory.appliedDecisions.filter(item =>
      withinProvider(item) && item.appliedEvidenceIds.every(id => permitted.has(id))), 10),
    assessments: take(memory.assessments.filter(withinProvider), 10),
    omittedHistory,
  };
  while (Buffer.byteLength(JSON.stringify(context)) > maxBytes) {
    const collection = [
      context.evidence,
      context.assessments,
      context.appliedDecisions,
      context.decisions,
      context.lessons,
      context.questions,
    ].find(items => items.length);
    if (!collection) throw Error('Companion review context cannot fit its bound.');
    collection.shift();
    context.omittedHistory = true;
  }
  return context;
}
