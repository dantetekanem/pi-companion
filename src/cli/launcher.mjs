const controls = /[\x00-\x1f\x7f-\x9f]/;
const plain = value => typeof value === 'string' && value.trim() !== '' && !controls.test(value);
// A launcher supplies Pi's credentials itself; Companion neither reads nor stores them.
const credentialWords = new Set(['KEY', 'APIKEY', 'TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'CREDENTIAL', 'CREDENTIALS', 'AUTH', 'BEARER']);
const credential = name => name.split('_').some(word => credentialWords.has(word));

export function validateLauncher(launcher) {
  if (launcher === undefined) return;
  const { command, env = {}, managedExtensions = false } = launcher ?? {};
  if (!launcher || typeof launcher !== 'object' || Array.isArray(launcher)
    || Object.keys(launcher).some(key => !['command', 'env', 'managedExtensions'].includes(key))) {
    throw Error('launcher accepts only command, env and managedExtensions');
  }
  if (!Array.isArray(command) || command.length < 1 || command.length > 8 || !command.every(plain) || command[0].startsWith('-')) {
    throw Error('launcher.command must list 1–8 plain strings, the first not starting with -');
  }
  if (!env || typeof env !== 'object' || Array.isArray(env) || Object.keys(env).length > 20) {
    throw Error('launcher.env must be an object of at most 20 entries');
  }
  for (const [name, value] of Object.entries(env)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || credential(name) || typeof value !== 'string' || controls.test(value)) {
      throw Error(`launcher.env.${name} must be a plain string under an uppercase name that is not a credential`);
    }
  }
  if (typeof managedExtensions !== 'boolean') throw Error('launcher.managedExtensions must be true or false');
}

export function piCommand(launcher, args) {
  validateLauncher(launcher);
  return launcher
    ? { command: launcher.command[0], args: [...launcher.command.slice(1), ...args] }
    : { command: 'pi', args };
}

// A launcher owns Pi's environment, so Companion adds only launcher.env and leaves network and telemetry defaults to it.
export const piEnvironment = launcher => launcher
  ? { ...process.env, ...launcher.env }
  : { ...process.env, PI_OFFLINE: '1', PI_TELEMETRY: '0' };
