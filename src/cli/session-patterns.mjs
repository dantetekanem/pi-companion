import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const defaults = {
  files: 20,
  fileBytes: 1048576,
  totalBytes: 4194304,
  requests: 100,
  requestChars: 1000,
  evidenceChars: 24000,
};
const ceilings = {
  files: 100,
  fileBytes: 8388608,
  totalBytes: 33554432,
  requests: 1000,
  requestChars: 4000,
  evidenceChars: 48000,
};
const digest = value => createHash('sha256').update(value).digest('hex');
const textContent = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : '';

function selectedBytes(path, limit) {
  if (!lstatSync(path).isFile()) throw Error('not_regular_file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw Error('not_regular_file');
    if (stat.size > limit) throw Error('file_limit');
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    let read;
    while (size < buffer.length && (read = readSync(fd, buffer, size, buffer.length - size, null)) > 0) {
      size += read;
    }
    if (size > limit) throw Error('file_limit');
    return buffer.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}

/** Collect only an explicit, dated selection. It neither discovers files nor submits model work. */
export function collectSessionPatterns(selection = {}) {
  if (!selection.consent) return { status: 'not_requested' };
  const { consent, sources, from, to, excludeFiles = [], excludeText = [] } = selection;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!['pi', 'claude'].includes(consent.harness) || (consent.model != null && typeof consent.model !== 'string')
    || !Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    throw Error('Explicit provider scope and valid date window are required.');
  }
  if (!Array.isArray(sources) || sources.length > 200
    || sources.some(source => !['pi', 'claude'].includes(source.harness) || !isAbsolute(source.path ?? ''))) {
    throw Error('Select at most 200 absolute Pi/Claude session file paths.');
  }
  if (!Array.isArray(excludeFiles) || excludeFiles.some(path => !isAbsolute(path)) || !Array.isArray(excludeText)
    || excludeText.length > 20 || excludeText.some(value => typeof value !== 'string' || !value.trim())) {
    throw Error('Invalid source exclusions.');
  }
  const limits = { ...defaults, ...selection.limits };
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(ceilings, key) || !Number.isInteger(value) || value < 1 || value > ceilings[key]) {
      throw Error(`Invalid collection limit: ${key}`);
    }
  }
  const requests = [];
  const omissions = [];
  const manifests = [];
  const seen = new Set();
  const toolCounts = new Map();
  const excluded = new Set(excludeFiles.map(path => resolve(path)));
  let totalBytes = 0;
  let evidenceChars = 0;
  let inspectedFiles = 0;
  let inspectedLines = 0;
  let outsideWindow = 0;
  const omit = (path, reason, line) => {
    if (omissions.length < 100) omissions.push({ path, reason, ...(line ? { line } : {}) });
  };
  for (const source of sources) {
    const path = resolve(source.path);
    if (excluded.has(path)) {
      omit(path, 'excluded_file');
      continue;
    }
    if (inspectedFiles >= limits.files) {
      omit(path, 'file_count_limit');
      continue;
    }
    if (totalBytes >= limits.totalBytes) {
      omit(path, 'total_byte_limit');
      continue;
    }
    let bytes;
    try {
      bytes = selectedBytes(path, Math.min(limits.fileBytes, limits.totalBytes - totalBytes));
    } catch (error) {
      omit(path, ['file_limit', 'not_regular_file'].includes(error.message) ? error.message : 'unreadable_file');
      continue;
    }
    const hash = digest(bytes);
    manifests.push({ harness: source.harness, path, sha256: hash, bytes: bytes.length });
    totalBytes += bytes.length;
    inspectedFiles++;
    let sessionId;
    for (const [index, line] of bytes.toString('utf8').split('\n').entries()) {
      if (!line.trim()) continue;
      inspectedLines++;
      let event;
      try {
        event = JSON.parse(line);
        if (!event || typeof event !== 'object') throw Error();
      } catch {
        omit(path, 'malformed_line', index + 1);
        continue;
      }
      if (source.harness === 'pi' && event.type === 'session') {
        sessionId = event.id;
        continue;
      }
      if (event.isMeta || event.isSidechain || !event.message || !['message', 'user', 'assistant'].includes(event.type)) continue;
      const timestamp = event.timestamp ?? event.message.timestamp;
      const time = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
      if (!Number.isFinite(time)) {
        omit(path, 'missing_date', index + 1);
        continue;
      }
      if (time < start || time > end) {
        outsideWindow++;
        continue;
      }
      const identity = `${source.harness}:${event.sessionId ?? sessionId ?? hash}:${event.uuid ?? event.id ?? index}`;
      if (seen.has(identity)) {
        omit(path, 'duplicate_event', index + 1);
        continue;
      }
      seen.add(identity);
      if (event.message.role === 'assistant' && Array.isArray(event.message.content)) {
        for (const part of event.message.content) {
          if (['toolCall', 'tool_use'].includes(part.type) && typeof part.name === 'string') {
            toolCounts.set(part.name, (toolCounts.get(part.name) ?? 0) + 1);
          }
        }
        continue;
      }
      if (event.message.role !== 'user') continue;
      const text = textContent(event.message.content).trim();
      if (!text) continue;
      if (excludeText.some(term => text.toLowerCase().includes(term.toLowerCase()))) {
        omit(path, 'excluded_text', index + 1);
        continue;
      }
      if (requests.length >= limits.requests || evidenceChars >= limits.evidenceChars) {
        omit(path, 'evidence_limit', index + 1);
        continue;
      }
      const excerpt = text.slice(0, Math.min(limits.requestChars, limits.evidenceChars - evidenceChars));
      evidenceChars += excerpt.length;
      requests.push({
        evidenceId: `session:${digest(identity).slice(0, 24)}`,
        harness: source.harness,
        path,
        line: index + 1,
        at: new Date(time).toISOString(),
        text: excerpt,
        truncated: excerpt.length !== text.length,
      });
    }
  }
  const groups = new Map();
  for (const request of requests) {
    if (request.truncated) continue;
    const key = request.text.toLowerCase().replace(/\s+/g, ' ').trim();
    const group = groups.get(key) ?? { text: request.text, count: 0, dates: [], evidenceIds: [] };
    group.count++;
    group.dates.push(request.at);
    group.evidenceIds.push(request.evidenceId);
    groups.set(key, group);
  }
  return {
    status: 'collected',
    destination: { harness: consent.harness, model: consent.model ?? null },
    from,
    to,
    coverage: {
      selectedFiles: sources.length,
      inspectedFiles,
      inspectedLines,
      totalBytes,
      outsideWindow,
      basis: 'Observed user-role requests and tool names only; not proof of human authorship or unused workflows.',
      limits,
    },
    sources: manifests,
    requests,
    tools: [...toolCounts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    repetitions: [...groups.values()].filter(group => group.count > 1),
    omissions,
  };
}
