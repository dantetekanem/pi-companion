import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { efforts } from './schedules.mjs';

const settingsScope = Type.Union(['main', 'background', 'schedules', 'all'].map(value => Type.Literal(value)));
const settingsEffort = Type.Union([...new Set(Object.values(efforts).flat())].map(value => Type.Literal(value)));
const settingsParameters = Type.Union([
  Type.Object({ action: Type.Literal('inspect'), scope: settingsScope }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal('update'),
    scope: settingsScope,
    model: Type.Optional(Type.String({ minLength: 3, maxLength: 200 })),
    effort: Type.Optional(settingsEffort),
  }, { additionalProperties: false }),
]);

export function createScheduleTool(triggerSchedule) {
  const parameters = Type.Object({
    scheduleId: Type.Optional(Type.String({ minLength: 1, maxLength: 80, pattern: '^[a-z0-9][a-z0-9._-]*$' })),
  }, { additionalProperties: false });
  return defineTool({
    name: 'run_schedule',
    label: 'Run scheduled check once',
    description: 'Only on an explicit user request, run one exact native schedule ID now, even if paused or outside its calendar. No settings change. Omit scheduleId to list up to 20 candidates. Returns admission, not completion; results appear in Reports.',
    parameters,
    async execute(id, request, signal) {
      if (!Check(parameters, request)) throw Error('Invalid schedule request.');
      signal?.throwIfAborted();
      if (!triggerSchedule) throw Error('Schedule triggering is unavailable.');
      const details = await triggerSchedule(request.scheduleId, id, signal);
      return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
    },
  });
}

/** `run(request, signal)` returns the receipt; the host that owns the session and settings supplies it. */
export function createSettingsTool(run) {
  return defineTool({
    name: 'model_settings',
    label: 'Model and effort settings',
    description: 'Inspect or update model and effort for exactly main, background, schedules, or all. Updates require an installed provider/model reference and persist only Companion settings, never Pi global defaults. Main updates also call this session’s non-persistent SDK setters; the receipt separates saved settings from the observed active binding.',
    parameters: settingsParameters,
    async execute(_id, request, signal) {
      if (!Check(settingsParameters, request)) throw Error('Invalid model settings request.');
      signal?.throwIfAborted();
      if (!run) throw Error('Model settings are unavailable.');
      const details = await run(request, signal);
      return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
    },
  });
}
