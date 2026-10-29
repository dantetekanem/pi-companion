import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sha256 } from './migration/inventory.mjs';

const worker = fileURLToPath(new URL('./legacy-worker.mjs', import.meta.url));
const pin = path => {
  path = realpathSync(path);
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > 2097152) throw Error('Compatibility dependency must be a bounded regular file.');
  return { path, sha256: sha256(readFileSync(path)) };
};
export function verifyEnginePins(binding) {
  if (binding?.version !== '0.5.1' || !Array.isArray(binding.pins) || binding.pins.length !== 4) throw Error('Invalid compatibility engine identity.');
  for (const item of binding.pins) {
    if (JSON.stringify(pin(item.path)) !== JSON.stringify(item)) throw Error('Compatibility dependency pin changed.');
  }
  if (binding.core !== binding.pins[1].path) throw Error('Compatibility entry point changed.');
  new Intl.DateTimeFormat('en', { timeZone: binding.timezone }).format();
}

/** Executes installed, trusted pure helpers, not the scheduler extension or its stored tasks. */
export class SchedulerCompatibility {
  static open(packageDirectory) {
    if (!isAbsolute(packageDirectory ?? '')) throw Error('Select the installed scheduler package by absolute directory.');
    const manifest = pin(join(packageDirectory, 'package.json'));
    const metadata = JSON.parse(readFileSync(manifest.path, 'utf8'));
    if (metadata.name !== '@jl1990/pi-scheduler' || metadata.version !== '0.5.1') throw Error('Compatibility requires installed pi-scheduler 0.5.1.');
    const core = pin(join(packageDirectory, 'extensions/scheduler/scheduler-core.cjs'));
    const require = createRequire(core.path);
    const cron = pin(require.resolve('croner'));
    const cronManifest = pin(require.resolve('croner/package.json'));
    if (JSON.parse(readFileSync(cronManifest.path, 'utf8')).version !== '10.0.1') throw Error('Compatibility requires croner 10.0.1.');
    return new SchedulerCompatibility({ version: '0.5.1', core: core.path, pins: [manifest, core, cron, cronManifest] });
  }

  constructor(identity) {
    this.identity = identity;
  }

  async validate(task, timezone) {
    const binding = { ...this.identity, timezone };
    await this.request(binding, 'validate', { task });
    return binding;
  }

  async request(binding, operation, input, signal) {
    if (JSON.stringify({ version: binding.version, core: binding.core, pins: binding.pins }) !== JSON.stringify(this.identity)) throw Error('Compatibility engine identity changed.');
    verifyEnginePins(binding);
    if (!['validate', 'prepare', 'complete', 'shell-wake'].includes(operation)) throw Error('Unsupported compatibility operation.');
    const payload = JSON.stringify({ binding, operation, ...input });
    if (Buffer.byteLength(payload) > 1048576) throw Error('Compatibility input exceeds its bound.');
    if (signal?.aborted) throw Error('Compatibility operation cancelled.');
    return new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [worker], {
        env: { ...process.env, TZ: binding.timezone },
        timeout: 5000,
        killSignal: 'SIGKILL',
        maxBuffer: 2097152,
        encoding: 'utf8',
        signal,
      }, (error, stdout) => {
        if (error) {
          reject(Error('Compatibility helper failed or was interrupted; no execution was retried.'));
          return;
        }
        try {
          const response = JSON.parse(stdout);
          if (!response.ok) throw Error('The persisted schedule is not valid for the pinned scheduler.');
          resolve(response.value);
        } catch (failure) {
          reject(failure);
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(payload);
    });
  }
}
