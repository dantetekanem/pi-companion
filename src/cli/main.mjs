#!/usr/bin/env node
import { resolve } from 'node:path';
import { defaultRoot, initialize, legacySources } from './config.mjs';
import { loadImportedHistory } from './history.mjs';
import { readLocalView, savePresentationState } from './view.mjs';
import { deleteReports } from './reports.mjs';

export function parseArguments(args) {
  const values = [...args];
  const options = { command: 'status', root: resolve(defaultRoot()), explicitRoot: false, plain: false, args: [] };
  if (values[0] && !values[0].startsWith('-')) options.command = values.shift();
  while (values.length) {
    const flag = values.shift();
    if (flag === '--home' && values[0] && !values[0].startsWith('-')) {
      options.root = resolve(values.shift());
      options.explicitRoot = true;
    } else if (['--selection', '--preview', '--confirm'].includes(flag) && values[0] && !values[0].startsWith('-')) {
      options[flag.slice(2)] = values.shift();
    } else if (flag === '--plain') options.plain = true;
    else if (flag === '--help' || flag === '-h') options.command = 'help';
    else if (options.command === 'reports' && !flag.startsWith('-')) options.args.push(flag);
    else throw Error(`Unknown or incomplete option: ${flag}`);
  }
  return options;
}

async function connected(options, snapshot, output, dependencies) {
  const signals = dependencies.signals ?? process;
  const done = Promise.withResolvers();
  const cancellation = new AbortController();
  const stop = () => {
    cancellation.abort();
    done.resolve();
  };
  let dashboard;
  let app;
  let keepAlive;
  signals.on('SIGINT', stop);
  signals.on('SIGTERM', stop);
  try {
    if (options.command !== 'run') {
      const start = dependencies.startDashboard ?? (await import('./ui.mjs')).startDashboard;
      dashboard = start(snapshot, {
        onQuit: stop,
        send: text => {
          if (!app) throw Error('Main conversation is still connecting.');
          return app.send(text);
        },
        clear: messageIds => savePresentationState(options.root, messageIds),
        reset: () => {
          if (!app) throw Error('Main conversation is still connecting.');
          return app.reset();
        },
        kill: runId => {
          if (!app) throw Error('Companion is still connecting.');
          return app.kill(runId);
        },
      }, { theme: { cwd: snapshot.config.main.cwd } });
    } else {
      keepAlive = setInterval(() => {}, 60000);
      output.write('Pi Companion running in this process. SIGINT/SIGTERM stops owned work.\n');
    }
    const open = dependencies.openApplication ?? (await import('./application.mjs')).CompanionApplication.open;
    app = await open(options.root, {
      signal: cancellation.signal,
      onChange: view => dashboard?.update(view),
      askQuestion: (request, signal) => dashboard?.askQuestion(request, signal),
    });
    await done.promise;
    return 0;
  } finally {
    clearInterval(keepAlive);
    signals.removeListener('SIGINT', stop);
    signals.removeListener('SIGTERM', stop);
    dashboard?.stop();
    await app?.close();
  }
}

export async function main(args = process.argv.slice(2), output = process.stdout, dependencies = {}) {
  const options = parseArguments(args);
  if (options.command === 'help') {
    output.write('Pi Companion\nUsage: pi-companion [command] [options]\n  init | schedules | status | history | run  [--home directory] [--plain]\n  patterns-preview --selection file\n  patterns-submit --preview HASH --confirm HASH\n  upgrade-plan --selection file\n  upgrade-prepare --selection plan.json --confirm HASH\n  upgrade-apply --confirm MIGRATION_ID [--selection authorization.json]\n  upgrade-status\n  reports [delete ID...]  list the Reports inventory as JSON, or delete reports by ID\n');
    return 0;
  }
  if (options.command.startsWith('upgrade-')) {
    const { planUpgrade, prepareUpgrade, applyUpgrade, upgradeStatus, readUpgradeJson } = await import('./migration/commands.mjs');
    let result;
    if (options.plain && ['upgrade-prepare', 'upgrade-apply'].includes(options.command)) {
      throw Error('Plain mode cannot prepare or apply an upgrade.');
    }
    if (options.command === 'upgrade-status') {
      result = upgradeStatus(options.root);
    } else if (options.command === 'upgrade-apply') {
      result = await applyUpgrade(options.root, {
        confirmation: options.confirm,
        authorization: options.selection ? readUpgradeJson(resolve(options.selection)) : {},
      });
    } else if (['upgrade-plan', 'upgrade-prepare'].includes(options.command)) {
      if (!options.selection) throw Error('Select an explicit upgrade JSON file.');
      const input = readUpgradeJson(resolve(options.selection));
      result = options.command === 'upgrade-plan'
        ? planUpgrade(input)
        : await prepareUpgrade(options.root, input, options.confirm);
    } else {
      throw Error(`Unknown command: ${options.command}`);
    }
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.status === 'repair_review' ? 2 : 0;
  }
  if (options.command === 'patterns-preview' || options.command === 'patterns-submit') {
    const { previewPatterns, readSelection, submitPatterns } = await import('./patterns.mjs');
    if (options.command === 'patterns-preview') {
      if (!options.selection) throw Error('Select an explicit JSON selection file.');
      output.write(`${JSON.stringify(previewPatterns(options.root, readSelection(resolve(options.selection))), null, 2)}\n`);
      return 0;
    }
    if (options.plain) throw Error('Plain mode cannot submit provider work.');
    const signals = dependencies.signals ?? process;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signals.on('SIGINT', cancel);
    signals.on('SIGTERM', cancel);
    try {
      const receipt = await submitPatterns(options.root, {
        hash: options.preview,
        confirmation: options.confirm,
        signal: controller.signal,
      });
      output.write(`${JSON.stringify(receipt, null, 2)}\n`);
      return receipt.status === 'completed' ? 0 : 1;
    } finally {
      signals.removeListener('SIGINT', cancel);
      signals.removeListener('SIGTERM', cancel);
    }
  }
  if (options.command === 'reports') {
    const inventory = () => readLocalView(options.root).reports;
    if (!options.args.length) {
      output.write(`${JSON.stringify(inventory(), null, 2)}\n`);
      return 0;
    }
    const [action, ...ids] = options.args;
    if (action !== 'delete' || !ids.length) throw Error('Usage: pi-companion reports [delete ID...]');

    const before = inventory();
    const known = new Set(before.map(report => report.id));
    const unknown = ids.filter(id => !known.has(id));
    if (unknown.length) throw Error(`Unknown report IDs; nothing deleted: ${unknown.join(', ')}`);

    deleteReports(options.root, ids);
    const result = {
      deleted: [...new Set(ids)],
      before: before.length,
      after: inventory().length,
    };
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (options.command === 'history') {
    output.write(`${JSON.stringify(loadImportedHistory(options.root), null, 2)}\n`);
    return 0;
  }
  if (!['init', 'schedules', 'status', 'run'].includes(options.command)) throw Error(`Unknown command: ${options.command}`);
  const tty = output.isTTY && (dependencies.input ?? process.stdin).isTTY;
  const connect = !options.plain && (options.command === 'run' || (options.command === 'status' && tty));
  if (options.command === 'init') initialize(options.root, { legacySources: options.explicitRoot ? [] : legacySources() });
  else if (connect) initialize(options.root);
  const snapshot = readLocalView(options.root);
  const { config, schedules, counts, errors, usage } = snapshot;
  if (connect) {
    return connected(options, snapshot, output, dependencies);
  }
  output.write(`Pi Companion · ${options.root}\nDaily ${counts.daily} · Weekly ${counts.weekly} · Monthly ${counts.monthly} · Migrated ${counts.compatibility ?? 0}\n`);
  output.write(`Background ${config.background.harness} · ${config.background.effort} · ${config.background.model ?? 'configured default'}\n`);
  output.write(`Initialized ${config.initializedAt} · Main not connected · $${usage.usd.toFixed(4)} estimated (${usage.coverage})\n`);
  if (snapshot.savedAt) output.write(`Saved view ${snapshot.savedAt}; not a liveness check\n`);
  for (const item of schedules) {
    output.write(`${item.enabled ? 'enabled' : 'paused'}  ${item.cadence}/${item.id}  ${item.title}\n`);
  }
  for (const error of errors) {
    output.write(`Invalid ${error.path}: ${error.message}\n`);
  }
  return errors.length ? 1 : 0;
}

if (import.meta.main) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`Pi Companion: ${error.message}\n`);
    if (error.diagnostics) process.stderr.write(`${JSON.stringify(error.diagnostics, null, 2)}\n`);
    process.exitCode = 1;
  });
}
