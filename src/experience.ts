import { appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';
import { Store } from './store.ts';
import { references, answer } from './reflection-core.mjs';
export { ReflectionSchema, curate, view } from './reflection-core.mjs';

const id = () => Type.String({ pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$' });
const text = () => Type.String({ minLength: 1, maxLength: 2000, pattern: '^[^\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f]+$' });
const ids = (minimum = 1) => Type.Array(id(), { minItems: minimum, maxItems: 12, uniqueItems: true });
const values = <T extends string>(items: T[]) => Type.Unsafe<T>({ type: 'string', enum: items });
const object = <T extends Parameters<typeof Type.Object>[0]>(fields: T) => Type.Object(fields, { additionalProperties: false });
export const RecordSchema = Type.Union([
  object({ kind: Type.Literal('observation'), id: id(), text: text(), evidenceIds: ids(0) }),
  object({
    kind: Type.Literal('outcome'),
    id: id(),
    taskId: id(),
    runId: id(),
    text: text(),
    outcome: values(['completed', 'no_change', 'incomplete', 'failed']),
    evidenceIds: ids(0),
  }),
  object({ kind: Type.Literal('question'), id: id(), text: text(), evidenceIds: ids(0) }),
  object({ kind: Type.Literal('publication'), id: id(), taskId: id(), runId: id(), text: text(), evidenceIds: ids(0) }),
  object({ kind: Type.Literal('answer'), id: id(), questionId: id(), evidenceIds: ids() }),
  object({ kind: Type.Literal('applied'), id: id(), decisionId: id(), evidenceIds: ids() }),
]);
export type Reflection = {
  assessments: {
    taskId: string;
    signal: 'helpful' | 'dismissed' | 'completed' | 'no_observed_response' | 'unknown';
    basis: 'explicit' | 'observed' | 'inferred';
    reason: string;
    evidenceIds: string[];
  }[];
  lessons: {
    id: string;
    action: 'upsert' | 'remove';
    text: string;
    confidence: 'tentative' | 'supported';
    evidenceIds: string[];
  }[];
  decisions: {
    id: string;
    action: 'create' | 'revise' | 'pause' | 'retire' | 'ask';
    taskId?: string;
    proposal: string;
    successSignal: string;
    evidenceIds: string[];
  }[];
  answers: { questionId: string; evidenceIds: string[] }[];
};
export type Evidence = {
  id: string;
  at: string;
  provider: string;
  text: string;
  kind: 'user' | 'observation' | 'delivery' | 'schedule' | 'outcome' | 'publication' | 'question' | 'answer' | 'applied';
  taskId?: string;
  runId?: string;
  refs?: string[];
  outcome?: string;
};
export type Wake = {
  token: string;
  schedule: string;
  schedulerId?: string;
  requested?: boolean;
  pausedAt?: string;
};
export type Review = {
  id: string;
  day: string;
  at: string;
  status: 'pending' | 'completed' | 'failed';
  binding?: { model: string; thinking: string };
  evidenceIds: string[];
  cost?: number;
  error?: string;
};
export type Experience = {
  version: 1;
  enabled: boolean;
  generation: number;
  wake?: Wake;
  pendingWake?: string;
  evidence: Evidence[];
  questions: { id: string; text: string; at: string; status: 'open' | 'answered'; answerIds: string[] }[];
  lessons: (Reflection['lessons'][number] & { at: string })[];
  decisions: (Reflection['decisions'][number] & { at: string; appliedEvidenceIds?: string[] })[];
  assessments: (Reflection['assessments'][number] & { at: string })[];
  reviews: Review[];
};
const empty = (): Experience => ({
  version: 1,
  enabled: false,
  generation: 0,
  evidence: [],
  questions: [],
  lessons: [],
  decisions: [],
  assessments: [],
  reviews: [],
});

export class ExperienceStore {
  private store: Store;

  constructor(root: string, sessionId: string) {
    this.store = new Store(root, sessionId);
  }

  load(): Experience {
    const value = this.store.load().experience;
    if (value === undefined) return empty();
    if (value.version !== 1 || typeof value.enabled !== 'boolean' || !Number.isInteger(value.generation)
      || !['evidence', 'questions', 'lessons', 'decisions', 'assessments', 'reviews'].every(key => Array.isArray(value[key as keyof Experience]))) {
      throw Error('Invalid Companion experience storage.');
    }
    return value;
  }

  update<T>(change: (state: Experience) => T): T {
    const base = this.store.load();
    base.experience = this.load();
    const result = change(base.experience);
    this.store.save(base);
    return result;
  }
}
export function recordEvidence(state: Experience, input: Omit<Evidence, 'at'>, at = new Date().toISOString()): boolean {
  const previous = state.evidence.find(item => item.id === input.id);
  if (previous) {
    const { at: _at, ...saved } = previous;
    if (!isDeepStrictEqual(saved, input)) throw Error('Evidence ID conflicts with an existing observation.');
    return false;
  }
  state.evidence.push({ ...input, at });
  return true;
}
export function record(state: Experience, input: Static<typeof RecordSchema>, reports: string, provider: string, at = new Date().toISOString(), publicationScope = 'local'): void {
  if (!state.enabled) throw Error('Companion is stopped.');
  if (!Check(RecordSchema, input)) throw Error('Invalid Companion record.');
  const refs = references(state, input.evidenceIds);
  if (refs.some(item => item.provider !== provider)) throw Error('Evidence belongs to a different provider.');
  if (!recordEvidence(state, {
    id: input.id,
    kind: input.kind,
    provider,
    refs: input.evidenceIds,
    text: 'text' in input ? input.text : JSON.stringify(input),
    ...('taskId' in input ? { taskId: input.taskId } : {}),
    ...('runId' in input ? { runId: input.runId } : {}),
    ...('outcome' in input ? { outcome: input.outcome } : {}),
  }, at)) return;
  if ('runId' in input && !state.evidence.some(item =>
    item.kind === 'delivery' && item.runId === input.runId && item.taskId === input.taskId && item.provider === provider)) {
    throw Error('Outcome or publication requires its own recorded task delivery.');
  }
  if (input.kind === 'question' || input.kind === 'publication') {
    const prefix = `<!-- companion-${input.kind}:${publicationScope}:${input.id}:`;
    const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const marker = `${prefix}${digest} -->`;
    let published = '';
    try {
      published = readFileSync(reports, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (published.includes(prefix) && !published.includes(marker)) throw Error('Publication ID conflicts with an earlier append.');
    if (!published.includes(marker)) {
      const heading = input.kind === 'question' ? 'Question' : input.taskId;
      appendFileSync(reports, `\n## ${at} · ${heading}\n\n${input.text}\n\n${marker}\n`, { mode: 0o600 });
    }
    if (input.kind === 'question') {
      state.questions.push({ id: input.id, text: input.text, at, status: 'open', answerIds: [] });
    }
  } else if (input.kind === 'answer') {
    answer(state, input.questionId, input.evidenceIds);
  } else if (input.kind === 'applied') {
    const decision = state.decisions.find(item => item.id === input.decisionId);
    if (!decision) throw Error('Unknown decision.');
    const receiptKind = decision.action === 'ask' ? 'question' : 'schedule';
    const matchingReceipt = refs.some(item => item.kind === receiptKind && item.at >= decision.at
      && (!decision.taskId || item.taskId === decision.taskId));
    if (!matchingReceipt) {
      throw Error('Application requires a later matching scheduler receipt or published question.');
    }
    decision.appliedEvidenceIds = input.evidenceIds;
  }
}
