import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { defineTool } from '@earendil-works/pi-coding-agent';

const text = maxLength => Type.String({ minLength: 1, maxLength, pattern: '^[^\\x00-\\x1f\\x7f-\\x9f]+$' });
const parameters = Type.Object({
  question: text(240),
  choices: Type.Array(Type.Object({
    value: text(80),
    label: text(80),
  }, { additionalProperties: false }), { minItems: 2, maxItems: 6 }),
}, { additionalProperties: false });

export function createQuestionTool(askQuestion) {
  return defineTool({
    name: 'ask_question',
    label: 'Ask a question',
    description: 'Ask the user one question with selectable answers in the terminal.',
    parameters,
    async execute(_id, request, signal) {
      if (!Check(parameters, request) || !request.question.trim()
        || request.choices.some(choice => !choice.value.trim() || !choice.label.trim())
        || new Set(request.choices.map(choice => choice.value)).size !== request.choices.length) {
        throw Error('Invalid question: provide 2–6 distinct choices and bounded plain text.');
      }
      const selected = signal?.aborted ? null : await askQuestion?.(structuredClone(request), signal);
      let details;
      if (selected === undefined) details = { status: 'unavailable' };
      else if (selected === null || signal?.aborted) details = { status: 'cancelled' };
      else {
        const answer = request.choices.find(choice => choice.value === selected);
        if (!answer) throw Error('Selected choice does not belong to this question.');
        details = { status: 'answered', answer: { ...answer } };
      }
      return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
    },
  });
}
