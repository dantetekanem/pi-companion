import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { sha256 } from './inventory.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(value);
function invalid(problem, code = 'invalid_state') {
  throw Object.assign(Error(problem), { code });
}
function requireValue(condition, path, expected) {
  if (!condition) invalid(`${path}: expected ${expected}`);
}
function array(value, path) {
  requireValue(Array.isArray(value), path, 'an array');
  return value;
}
function records(value, path, { unique = true, identity = true } = {}) {
  const seen = new Map();
  array(value, path).forEach((item, index) => {
    requireValue(object(item), `${path}[${index}]`, 'an object');
    if (!identity) return;
    requireValue(id(item.id), `${path}[${index}].id`, 'an ID');
    if (unique && seen.has(item.id)) invalid(`${path}[${index}].id: duplicate ID ${item.id}`);
    seen.set(item.id, item);
  });
  return seen;
}
function validateExperience(value) {
  requireValue(object(value) && value.version === 1, 'experience.version', 'version 1');
  requireValue(typeof value.enabled === 'boolean' && Number.isInteger(value.generation), 'experience', 'enabled boolean and integer generation');
  const evidence = records(value.evidence, 'experience.evidence');
  const questions = records(value.questions, 'experience.questions');
  const decisions = records(value.decisions, 'experience.decisions');
  records(value.lessons, 'experience.lessons', { unique: false });
  records(value.assessments, 'experience.assessments', { identity: false });
  records(value.reviews, 'experience.reviews');
  function reference(target, key, path) {
    if (!target.has(key)) invalid(`${path}: unknown reference ${JSON.stringify(key)}`, 'broken_reference');
    return target.get(key);
  }
  function links(ids, path, { provider, user = false } = {}) {
    return array(ids, path).map((key, index) => {
      const source = reference(evidence, key, `${path}[${index}]`);
      if (provider !== undefined && source.provider !== provider) invalid(`${path}[${index}]: evidence ${key} belongs to provider ${source.provider}, not ${provider}`, 'broken_reference');
      if (user && source.kind !== 'user') invalid(`${path}[${index}]: answer evidence ${key} is not user evidence`, 'broken_reference');
      return source;
    });
  }
  value.evidence.forEach((item, index) => {
    const path = `experience.evidence[${index}]`;
    requireValue(typeof item.provider === 'string' && item.provider.length > 0 && date(item.at) && typeof item.text === 'string', path, 'provider, timestamp and text');
    if (item.refs !== undefined) links(item.refs, `${path}.refs`, { provider: item.provider });
    if (['outcome', 'publication'].includes(item.kind) && !value.evidence.some(source => source.kind === 'delivery' && source.runId === item.runId && source.taskId === item.taskId && source.provider === item.provider)) {
      invalid(`${path}: no delivery for provider ${item.provider}, task ${item.taskId}, run ${item.runId}`, 'broken_reference');
    }
    if (['answer', 'applied'].includes(item.kind)) {
      let record;
      try {
        record = JSON.parse(item.text);
      } catch {
        invalid(`${path}.text: malformed ${item.kind} record`);
      }
      requireValue(object(record), `${path}.text`, 'a structured record');
      if (item.kind === 'answer') {
        reference(questions, record.questionId, `${path}.text.questionId`);
        links(record.evidenceIds, `${path}.text.evidenceIds`, { provider: item.provider, user: true });
      } else {
        reference(decisions, record.decisionId, `${path}.text.decisionId`);
        links(record.evidenceIds, `${path}.text.evidenceIds`, { provider: item.provider });
      }
    }
  });
  value.questions.forEach((item, index) => links(item.answerIds, `experience.questions[${index}].answerIds`, { user: true }));
  for (const group of ['lessons', 'decisions', 'assessments', 'reviews']) {
    value[group].forEach((item, index) => {
      links(item.evidenceIds, `experience.${group}[${index}].evidenceIds`);
      if (item.appliedEvidenceIds !== undefined) links(item.appliedEvidenceIds, `experience.${group}[${index}].appliedEvidenceIds`);
    });
  }
  if (value.wake !== undefined) requireValue(object(value.wake) && typeof value.wake.token === 'string' && typeof value.wake.schedule === 'string', 'experience.wake', 'a wake token and schedule');
  if (value.pendingWake !== undefined) requireValue(typeof value.pendingWake === 'string', 'experience.pendingWake', 'a string');
}
function validateState(value) {
  requireValue(object(value) && value.version === 1, 'version', 'version 1');
  records(value.items, 'items');
  value.items.forEach((item, index) => {
    const path = `items[${index}]`;
    requireValue(['update', 'report'].includes(item.kind) && item.final === true && typeof item.title === 'string' && typeof item.body === 'string', path, 'a final update or report with title and body');
    requireValue(date(item.savedAt) && (item.readAt === undefined || date(item.readAt)), path, 'valid savedAt and optional readAt timestamps');
    requireValue(array(item.checks, `${path}.checks`).length > 0, `${path}.checks`, 'at least one source check');
    item.checks.forEach((check, checkIndex) => {
      requireValue(object(check)
        && typeof check.source === 'string'
        && typeof check.detail === 'string'
        && ['findings', 'no_change', 'failed', 'incomplete', 'not_run'].includes(check.outcome),
      `${path}.checks[${checkIndex}]`, 'a source, detail and known outcome');
    });
  });
  for (const group of ['paused', ...(value.stopping === undefined ? [] : ['stopping'])]) {
    array(value[group], group).forEach((item, index) => {
      requireValue(object(item)
        && typeof item.id === 'string'
        && typeof item.signature === 'string'
        && (group !== 'paused' || typeof item.disabledAt === 'string'),
      `${group}[${index}]`, 'a schedule receipt');
    });
  }
  if (value.started !== undefined) requireValue(typeof value.started === 'boolean', 'started', 'a boolean');
  if (value.experience !== undefined) validateExperience(value.experience);
}

/** Imports all inventoried state buckets; any errors block the caller's overall migration. */
export function importStates(journal, { overrides = [] } = {}) {
  const record = journal.record;
  if (record.phase !== 'staged') throw Error('State import requires fully staged originals.');
  journal.verifyArchive();
  const entries = record.manifest.files.filter(entry => entry.category === 'state');
  const artifacts = [];
  const origins = entries.map(entry => ({
    origin: entry.origin,
    source: { ...entry, archivePath: journal.sourcePath(entry) },
  }));
  const errors = [];
  const repairs = new Map();
  for (const override of overrides) {
    const entry = entries.find(item => item.path === override?.path);
    if (!entry || entry.sha256 !== override.sha256 || repairs.has(override.path) || !object(override.provenance) || !Object.keys(override.provenance).length || !Object.hasOwn(override, 'value')) {
      errors.push({
        code: 'invalid_override',
        origin: entry?.origin ?? null,
        source: entry ?? { path: override?.path ?? null },
        problem: 'Override requires one known source path, matching raw sha256, structured value and nonempty provenance.',
      });
    } else repairs.set(override.path, override);
  }
  if (errors.length) return { artifacts, origins, errors };
  const seen = new Set();
  for (const { origin, source } of origins) {
    try {
      if (seen.has(origin)) invalid(`Duplicate source origin ${origin}`);
      seen.add(origin);
      const repair = repairs.get(source.path);
      let legacy;
      if (repair) {
        const encoded = JSON.stringify({ value: repair.value, provenance: repair.provenance });
        const decoded = JSON.parse(encoded);
        if (!isDeepStrictEqual(decoded, { value: repair.value, provenance: repair.provenance })) invalid('Override value and provenance must be lossless JSON.', 'invalid_override');
        legacy = decoded.value;
      } else {
        try {
          legacy = JSON.parse(readFileSync(source.archivePath, 'utf8'));
        } catch {
          invalid('Malformed legacy JSON; inspect the preserved source privately.', 'invalid_json');
        }
      }
      validateState(legacy);
      const wrapper = { origin, source, legacy };
      if (repair) wrapper.override = { provenance: repair.provenance, sha256: sha256(JSON.stringify(legacy)) };
      const artifact = journal.writeData(`imported/states/${sha256(origin)}.json`, Buffer.from(JSON.stringify(wrapper)), { replace: Boolean(repair) });
      artifacts.push({ ...artifact, origin, source });
    } catch (error) {
      errors.push({ code: error.code ?? 'import_failed', origin, source, problem: error.message });
    }
  }
  return { artifacts, origins, errors };
}
