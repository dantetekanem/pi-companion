import { readSettings, updateSettings } from './settings.mjs';

function syncConfig(config, settings) {
  if (!settings || typeof settings !== 'object') return;
  for (const scope of ['main', 'background']) {
    if (settings[scope] && config[scope]) Object.assign(config[scope], settings[scope]);
  }
}

/**
 * The receipt behind the model_settings tool, shared by the in-process and the launcher session.
 * `binding()` reports the active main model and effort; `modelRuntime()` lists the installed models;
 * `apply({ model, effort })` changes the live session without saving Pi defaults and returns what it observed.
 */
export async function runModelSettings({ root, config, request, binding, modelRuntime, apply }) {
  if (request.action === 'inspect') {
    const details = {
      action: 'inspect',
      scope: request.scope,
      settings: readSettings(root, request.scope),
    };
    if (request.scope === 'main' || request.scope === 'all') details.activeMainBinding = await binding();
    return details;
  }

  let result;
  try {
    result = await updateSettings(root, {
      scope: request.scope,
      model: request.model,
      effort: request.effort,
    }, { modelRuntime: await modelRuntime(), applyCurrent: apply });
  } catch (error) {
    result = {
      scope: request.scope,
      persisted: {
        status: 'failed',
        completed: [],
        failed: { target: 'preflight', error: error instanceof Error ? error.message : String(error) },
      },
      activeRuntime: { status: 'unchanged', reason: 'preflight rejected the update before persistence' },
    };
  }
  syncConfig(config, result.persisted?.settings);
  return {
    action: 'update',
    requested: {
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.effort === undefined ? {} : { effort: request.effort }),
    },
    ...result,
  };
}
