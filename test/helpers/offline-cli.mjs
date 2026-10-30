// Offline PTY fixture: real terminal/SDK storage, synthetic providers, temporary home only.
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../../src/cli/main.mjs';
import { initialize, atomicJson } from '../../src/cli/config.mjs';
import { CompanionApplication } from '../../src/cli/application.mjs';
import { startDashboard } from '../../src/cli/ui.mjs';
import { fakePi } from './pi-session.mjs';

const root = realpathSync(process.argv[2]);
const trace = value => appendFileSync(join(root, 'trace.txt'), value + '\n');
const config = initialize(root, { cwd: root, now: '2026-01-01T00:00:00Z' });
config.main.model = 'fixture/local';
config.background = { harness: 'pi', model: 'fixture-background', effort: 'high' };
atomicJson(join(root, 'config.json'), config);

const schedule = {
  id: 'check',
  title: 'Offline background',
  at: '09:00',
  timezone: 'UTC',
  cwd: root,
  enabled: true,
  context: [],
  ...config.background,
};
for (const id of ['check', 'check-two']) {
  writeFileSync(join(root, `schedules/daily/${id}.md`), `---\n${JSON.stringify({ ...schedule, id, title: id === 'check' ? schedule.title : 'Second offline background' })}\n---\nInspect the synthetic fixture.\n`);
}

const fake = fakePi(root);
const frames = [];
let ui;
const capture = () => {
  if (ui) {
    const frame = {
      columns: process.stdout.columns,
      rows: process.stdout.rows,
      state: ui.state(),
      lines: ui.render(process.stdout.columns, process.stdout.rows),
    };
    if (JSON.stringify(frame) !== JSON.stringify(frames.at(-1))) frames.push(frame);
  }
};
const interval = setInterval(capture, 40);
try {
  const code = await main(['--home', root], process.stdout, {
    startDashboard: (view, handlers) => {
      ui = startDashboard(view, {
        ...handlers,
        onQuit: () => {
          trace('quit');
          handlers.onQuit();
        },
      });
      capture();
      return ui;
    },
    openApplication: async (home, options) => {
      const app = await CompanionApplication.open(home, {
        ...options,
        sessionDependencies: fake.dependencies,
        now: () => new Date('2026-01-02T10:00:00Z'),
        createMain: async parameters => {
          const session = await fake.createMain(parameters);
          const prompt = session.prompt.bind(session);
          session.prompt = async (text, promptOptions) => {
            if (text === 'fail') {
              promptOptions.preflightResult?.(false);
              throw Error('Synthetic send failure');
            }
            if (text === 'wait') {
              promptOptions.preflightResult?.(true);
              await new Promise(resolve => {
                const timer = setTimeout(resolve, 6000);
                parameters.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
              });
              return prompt(text, { ...promptOptions, preflightResult: undefined });
            }
            if (text === 'scroll') text = Array.from({ length: 45 }, (_, i) => `Scroll row ${i}`).join('\n');
            if (text === 'question') {
              promptOptions.preflightResult?.(true);
              const answer = await parameters.askQuestion({
                question: 'Choose how to handle this synthetic check.',
                choices: Array.from({ length: 6 }, (_, i) => ({ value: `choice-${i}`, label: `Choice ${i}` })),
              });
              trace(`selected ${answer}`);
              return prompt(`Selected ${answer}`, { ...promptOptions, preflightResult: undefined });
            }
            return prompt(text, promptOptions);
          };
          return session;
        },
        runHarness: request => new Promise(resolve => {
          const finish = () => resolve({
            status: request.signal.aborted ? 'interrupted' : 'completed',
            sessionId: request.id,
            freshSession: true,
            cost: { usd: 0.1, sessionId: request.id, kind: 'estimate', cumulative: true },
            text: [
              '# Fixture finding 日本語', '',
              'The check finished while you were typing.', '',
              '- **Input** stayed available.',
              '- Reports use the full reading area.', '',
              '### Next step', '', 'Actionable details.',
            ].join('\n'),
          });
          const timer = setTimeout(finish, 2500);
          request.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            finish();
          }, { once: true });
        }),
      });
      const close = app.close.bind(app);
      app.close = async () => {
        trace('close start');
        await close();
        trace('close end');
      };
      trace('opened');
      return app;
    },
  });
  process.exitCode = code;
} finally {
  clearInterval(interval);
  capture();
  mkdirSync(join(root, 'artifacts'), { recursive: true });
  writeFileSync(join(root, 'artifacts/frames.json'), JSON.stringify(frames, null, 2));
}
