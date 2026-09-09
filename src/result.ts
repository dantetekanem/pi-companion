import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';

const text = (maxLength: number, multiline = false) => {
  const controls = multiline ? '\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f' : '\\x00-\\x1f\\x7f-\\x9f';
  const allowed = `[^${controls}]`;
  return Type.String({ minLength: 1, maxLength, pattern: `^${allowed}*[^\\s${controls}]${allowed}*$` });
};
const enumeration = <T extends string>(values: T[]) => Type.Unsafe<T>({ type: 'string', enum: values });
export const ResultSchema = Type.Object({
  id: Type.String({ pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' }),
  kind: enumeration(['update', 'report']), final: Type.Literal(true),
  title: text(120), body: text(32000, true),
  reason: Type.Optional(enumeration(['action', 'material', 'blocker'])),
  checks: Type.Array(Type.Object({
    source: text(160), outcome: enumeration(['findings', 'no_change', 'failed', 'incomplete', 'not_run']),
    detail: text(2000, true),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 40 }),
}, { additionalProperties: false });
export type Result = Static<typeof ResultSchema>;
export type Saved = Result & { savedAt: string; readAt?: string };
export type StopRequest = { id: string; signature: string };
export type Paused = StopRequest & { disabledAt: string };
export type State = { version: 1; started?: boolean; items: Saved[]; paused: Paused[]; stopping: StopRequest[] };
export const incomplete = (item: Result) => item.checks.some(c => ['failed', 'incomplete', 'not_run'].includes(c.outcome));
export function validateResult(value: unknown): Result {
  if (!Check(ResultSchema, value)) throw new Error('Invalid Companion result: supply a final result with explicit source checks.');
  if (value.kind === 'update' && (!value.reason || (value.reason !== 'blocker' && !value.checks.some(c => c.outcome === 'findings'))
    || (value.reason === 'blocker' && !incomplete(value) && !value.checks.some(c => c.outcome === 'findings')))) {
    throw new Error('An update needs an actionable finding, material change, or explicit blocker; no-change belongs in a report.');
  }
  return value;
}
export function label(item: Result): string {
  return `${item.title}${item.kind === 'report' ? ' report' : ''}${incomplete(item) ? ' incomplete' : ''}`;
}
export function footer(state: State, schedules?: number): string | undefined {
  if (state.started !== true) return undefined;
  return schedules === undefined ? 'Companion' : `Companion · ${schedules} schedule${schedules === 1 ? '' : 's'}`;
}
