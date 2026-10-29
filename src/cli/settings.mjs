import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson, loadConfig } from './config.mjs';
import { cadences, efforts, loadSchedules } from './schedules.mjs';
import { resolveDataRoot } from './migration/admission.mjs';

const scopes = ['main', 'background', 'schedules', 'all'];
function selected(scope) {
  if (!scopes.includes(scope)) throw Error(`scope must be one of: ${scopes.join(', ')}`);
  return { main: scope === 'main' || scope === 'all', background: scope === 'background' || scope === 'all', schedules: scope === 'schedules' || scope === 'all' };
}
function inspect(root, scope) {
  const targets = selected(scope);
  const config = loadConfig(root);
  let schedules = [];
  if (targets.schedules) {
    const loaded = loadSchedules(root);
    const dirs = cadences.map(cadence => join(root, 'schedules', cadence));
    const errors = loaded.errors.filter(item => dirs.some(dir => item.path === dir || item.path.startsWith(`${dir}${sep}`)));
    if (errors.length) throw Error(`Cannot update schedules with invalid native bindings: ${errors.map(item => item.path).join(', ')}`);
    schedules = loaded.schedules.filter(item => item.cadence !== 'compatibility');
  }
  return { targets, config, schedules };
}
function snapshot(root, scope, state = inspect(root, scope)) {
  const { targets, config, schedules } = state;
  return {
    scope,
    ...(targets.main ? { main: { model: config.main.model, effort: config.main.effort } } : {}),
    ...(targets.background ? { background: { harness: config.background.harness, model: config.background.model, effort: config.background.effort } } : {}),
    ...(targets.schedules ? { schedules: schedules.map(({ id, cadence, enabled, harness, model, effort }) => ({ id, cadence, enabled, harness, model, effort })) } : {}),
  };
}
export function readSettings(root, scope = 'all') { return snapshot(resolveDataRoot(root), scope); }
function resolveModel(reference, modelRuntime) {
  if (typeof reference !== 'string' || /[\s\x00-\x1f\x7f]/.test(reference)) throw Error('model must be fully qualified as provider/model');
  const slash = reference.indexOf('/');
  if (slash < 1 || slash === reference.length - 1) throw Error('model must be fully qualified as provider/model');
  const provider = reference.slice(0, slash);
  const id = reference.slice(slash + 1);
  const model = modelRuntime?.getModel(provider, id);
  if (!model || model.provider !== provider || model.id !== id) throw Error(`Model is not installed in the Pi catalog: ${reference}`);
  return model;
}
function writeSchedule(path, model, effort) {
  const stat = lstatSync(path);
  if (!stat.isFile()) throw Error(`Schedule is not a regular file: ${path}`);
  const source = readFileSync(path, 'utf8');
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) throw Error(`Invalid schedule frontmatter: ${path}`);
  const metadata = JSON.parse(match[1]);
  if (model !== undefined) metadata.model = `${model.provider}/${model.id}`;
  if (effort !== undefined) metadata.effort = effort;
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `---\n${JSON.stringify(metadata, null, 2)}\n---\n${source.slice(match[0].length)}`, { flag: 'wx', mode: stat.mode & 0o777 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
export async function updateSettings(root, request, { modelRuntime, applyCurrent } = {}) {
  root = resolveDataRoot(root);
  const { scope, model: reference, effort } = request ?? {};
  const state = inspect(root, scope);
  if (reference === undefined && effort === undefined) throw Error('Specify model, effort, or both.');
  const bindings = [
    ...(state.targets.main ? [{ scope: 'main', harness: 'pi' }] : []),
    ...(state.targets.background ? [{ scope: 'background', harness: state.config.background.harness }] : []),
    ...state.schedules.map(item => ({ scope: `schedules:${item.id}`, harness: item.harness, path: item.path })),
  ];
  const incompatible = bindings.filter(item => (reference !== undefined && item.harness !== 'pi') || (effort !== undefined && !efforts[item.harness]?.includes(effort)));
  if (incompatible.length) {
    const incompatibleScopes = incompatible.map(item => item.scope);
    return {
      scope, error: `Requested model/effort settings are incompatible with target harnesses: ${incompatibleScopes.join(', ')}; nothing changed`,
      persisted: { status: 'unchanged', settings: snapshot(root, scope, state), completed: [] },
      activeRuntime: { status: 'unchanged', reason: 'cross-harness preflight rejected the update' },
      unchangedScopes: [...new Set([...scopesFor(state.targets), ...bindings.filter(item => item.harness === 'pi').map(item => item.scope)])], incompatibleScopes,
    };
  }
  const resolved = reference === undefined ? undefined : resolveModel(reference, modelRuntime);
  const initial = snapshot(root, scope, state);
  const config = state.config;
  if (state.targets.main) {
    if (resolved) config.main.model = `${resolved.provider}/${resolved.id}`;
    if (effort !== undefined) config.main.effort = effort;
  }
  if (state.targets.background) {
    if (resolved) config.background.model = `${resolved.provider}/${resolved.id}`;
    if (effort !== undefined) config.background.effort = effort;
  }
  const targetNames = bindings.map(item => item.scope);
  const completed = [];
  let attempting = 'config.json';
  try {
    if (state.targets.main || state.targets.background) {
      atomicJson(join(root, 'config.json'), config);
      if (state.targets.main) completed.push('main');
      if (state.targets.background) completed.push('background');
    }
    for (const item of state.schedules) {
      attempting = `schedules:${item.id}`;
      writeSchedule(item.path, resolved, effort);
      completed.push(attempting);
    }
  } catch (error) {
    const settings = safeSnapshot(root, scope);
    const changed = JSON.stringify(settings) !== JSON.stringify(initial);
    return { scope, persisted: { status: changed ? 'partial' : 'failed', settings, completed, failed: { target: attempting, error: error.message }, notWritten: targetNames.filter(name => !completed.includes(name) && name !== attempting) }, activeRuntime: { status: 'unchanged', reason: 'not attempted because persistence was incomplete' }, unchangedScopes: scopesFor(state.targets) };
  }
  let activeRuntime = state.targets.main ? { status: 'unchanged', reason: 'no active-session setter supplied' } : { status: 'unchanged', reason: 'scope excludes the current conversation' };
  if (state.targets.main && applyCurrent) {
    try {
      const effective = await applyCurrent({ model: resolved, effort });
      const observedBinding = effective && typeof effective === 'object' && !Array.isArray(effective);
      const expectedModel = resolved ? `${resolved.provider}/${resolved.id}` : undefined;
      const matchesRequest = observedBinding
        && (expectedModel === undefined || effective.model === expectedModel)
        && (effort === undefined || effective.effort === effort);
      activeRuntime = matchesRequest
        ? { status: 'verified', effective }
        : observedBinding ? { status: 'unverified', effective } : { status: 'unverified' };
    } catch (error) {
      const effective = error && typeof error === 'object' ? error.effective : undefined;
      activeRuntime = {
        status: 'unverified',
        ...(effective && typeof effective === 'object' ? { effective } : {}),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { scope, persisted: { status: 'complete', settings: safeSnapshot(root, scope), completed }, activeRuntime, unchangedScopes: scopesFor(state.targets) };
}
function scopesFor(targets) { return ['main', 'background', 'schedules'].filter(scope => !targets[scope]); }
function safeSnapshot(root, scope) { try { return readSettings(root, scope); } catch (error) { return { error: error.message }; } }
