import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { bindingFromSession } from '../pi-session.mjs';
import { validateBinding } from '../schedules.mjs';
import { readSource } from './inventory.mjs';

/** Preserve executable model identities before declaring the complete schedule set ready. */
export async function importBindings(journal, { config, sessions, schedules, reviewSettings }) {
  const result = { ...config, main: { ...config.main }, legacySessions: {}, legacyReviews: {} };
  for (const review of Object.values(config.legacyReviews ?? {})) validateBinding({ harness: 'pi', ...review });
  const references = journal.record.manifest.references.filter(item => item.kind === 'review-settings');
  let originalReview;
  if (reviewSettings) {
    if (!references.some(reference => reference.path === reviewSettings.path)) throw Error('Review binding source was not explicitly inventoried.');
    let settings;
    try {
      settings = JSON.parse(readSource(reviewSettings).toString('utf8'));
    } catch {
      throw Error('Pinned review binding source changed or is invalid.');
    }
    const value = settings.favoriteModels?.['read-critical'];
    validateBinding({ harness: 'pi', ...value, effort: value?.thinking });
    originalReview = { model: value?.model, effort: value?.thinking };
  } else if (references.length) throw Error('The original review binding needs an exact settings pin.');
  const pins = new Map(sessions.map(session => [session.sessionId, session]));
  const main = pins.get(journal.record.selection.sessionId);
  if (!main) throw Error('Selected main binding has no pinned session.');
  const mainBinding = await bindingFromSession(
    readSource({ ...main, path: main.sessionFile }),
    config.main.model ? config.main : config.legacySessions?.[main.sessionId],
  );
  Object.assign(result.main, mainBinding);
  for (const artifact of schedules.artifacts.filter(item => item.kind === 'schedule')) {
    const wrapper = JSON.parse(readFileSync(journal.dataPath(artifact.path), 'utf8'));
    const id = wrapper.session.sessionId;
    const pin = pins.get(id);
    if (!pin) throw Error('Schedule delivery binding has no pinned session.');
    const binding = result.legacySessions[id] ?? await bindingFromSession(readSource({ ...pin, path: pin.sessionFile }), config.legacySessions?.[id]);
    result.legacySessions[id] = binding;
    if (id === journal.record.selection.sessionId) {
      if (result.main.model !== binding.model || result.main.effort !== binding.effort) throw Error('Main and migrated delivery bindings conflict.');
      Object.assign(result.main, binding);
    }
    if (wrapper.role !== 'daily-wake') continue;
    const review = config.legacyReviews?.[id] ?? originalReview;
    if (!review || typeof review.model !== 'string' || !/^[^/\s]+\/\S+$/.test(review.model)) throw Error('Daily wake requires its original or explicitly selected review binding.');
    validateBinding({ harness: 'pi', ...review });
    if (originalReview && !isDeepStrictEqual(review, originalReview)) throw Error('Selected review binding differs from the pinned original.');
    if (review.model.split('/')[0] !== binding.model.split('/')[0]) throw Error('Review binding cannot disclose this origin to a different provider.');
    result.legacyReviews[id] = { model: review.model, effort: review.effort };
  }
  const artifact = journal.writeData('imported/bindings.json', Buffer.from(JSON.stringify({
    version: 1,
    sessions: result.legacySessions,
    reviews: result.legacyReviews,
    reviewSettings: reviewSettings ?? null,
  })));
  return { config: result, artifact };
}
