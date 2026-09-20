import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { curate, ExperienceStore, view, type Experience, type Reflection } from './experience.ts';

export function reviewBinding(ctx: ExtensionContext, file: string) {
  // Teams documents favorite models as global-only; separate Pi packages do not share imports.
  const value = JSON.parse(readFileSync(file, 'utf8')).favoriteModels?.['read-critical'];
  if (typeof value?.model !== 'string' || typeof value.thinking !== 'string') throw Error('Companion daily review has no configured read-critical binding.');
  const slash = value.model.indexOf('/');
  if (slash < 1 || slash === value.model.length - 1) throw Error('The existing review model must be fully qualified.');
  const model = ctx.modelRegistry.find(value.model.slice(0, slash), value.model.slice(slash + 1));
  if (!model || model.api !== 'openai-codex-responses') throw Error('The configured daily review model is unavailable or its API is unsupported.');
  if (model.provider !== ctx.model?.provider) throw Error('Daily review cannot share this session with a different model provider.');
  const thinking = getSupportedThinkingLevels(model).find(level => level === value.thinking);
  if (!thinking) throw Error('The configured review effort is unsupported; it will not be downgraded.');
  return { model, thinking, name: value.model as string };
}
export function experienceContext(state: Experience, provider: string, maxBytes = 32000) {
  const memory = view(state);
  const permitted = new Set(state.evidence.filter(item => item.provider === provider).map(item => item.id));
  const withinProvider = (item: { evidenceIds: string[] }) => item.evidenceIds.every(id => permitted.has(id));
  const context = {
    evidence: memory.evidence.filter(item => permitted.has(item.id)).slice(-80),
    questions: memory.questions.filter(item => permitted.has(item.id)).slice(-12),
    lessons: memory.lessons.filter(withinProvider).slice(-12),
    decisions: memory.decisions.filter(withinProvider).slice(-10),
    appliedDecisions: memory.appliedDecisions.filter(item => withinProvider(item) && item.appliedEvidenceIds!.every(id => permitted.has(id))).slice(-10),
    assessments: memory.assessments.filter(withinProvider).slice(-10),
    omittedHistory: false,
  };
  while (Buffer.byteLength(JSON.stringify(context)) > maxBytes) {
    const collection = [context.evidence, context.assessments, context.appliedDecisions, context.decisions, context.lessons, context.questions].find(items => items.length);
    if (!collection) throw Error('Companion review context cannot fit its bound.');
    collection.shift();
    context.omittedHistory = true;
  }
  return context;
}
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Review aborted.'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export async function review(store: ExperienceStore, ctx: ExtensionContext, settings: string, signal: AbortSignal): Promise<boolean> {
  const initial = store.load();
  const at = new Date().toISOString(), day = at.slice(0, 10);
  if (!initial.enabled || initial.reviews.some(item => item.day === day)) return false;
  const id = randomUUID();
  store.update(state => state.reviews.push({ id, day, at, status: 'pending', evidenceIds: [] }));
  let cost: number | undefined;
  try {
    signal.throwIfAborted();
    const binding = reviewBinding(ctx, settings);
    const context = experienceContext(initial, binding.model.provider);
    const visibleIds = context.evidence.map(item => item.id);
    store.update(state => {
      const run = state.reviews.find(item => item.id === id)!;
      run.binding = { model: binding.name, thinking: binding.thinking };
      run.evidenceIds = visibleIds;
    });
    const response = await abortable(ctx.modelRegistry.complete(binding.model, {
      systemPrompt: readFileSync(new URL('./prompts/reflection.md', import.meta.url), 'utf8'),
      messages: [{ role: 'user', content: JSON.stringify(context), timestamp: Date.now() }],
    }, { reasoningEffort: binding.thinking === 'off' ? 'none' : binding.thinking,
      signal, sessionId: randomUUID(), cacheRetention: 'none' }), signal);
    if (Number.isFinite(response.usage?.cost?.total)) cost = response.usage.cost.total;
    signal.throwIfAborted();
    if (response.stopReason !== 'stop') throw Error(`Daily review did not complete (${response.stopReason}).`);
    const text = response.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    if (!text.trim() || Buffer.byteLength(text) > 32000) throw Error('Daily review returned empty or oversized output.');
    const result: Reflection = JSON.parse(text);
    store.update(state => {
      if (!state.enabled || state.generation !== initial.generation) throw Error('Companion changed or stopped during review.');
      curate(state, result, visibleIds);
      const run = state.reviews.find(item => item.id === id)!;
      run.status = 'completed';
      run.cost = cost;
    });
    return true;
  } catch (error) {
    store.update(state => {
      const run = state.reviews.find(item => item.id === id)!;
      run.status = 'failed';
      run.cost = cost;
      run.error = error instanceof Error ? error.message.slice(0, 500) : 'Daily review failed.';
    });
    throw error;
  }
}
