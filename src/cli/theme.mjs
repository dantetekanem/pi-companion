import { watch } from 'node:fs';
import { join } from 'node:path';
import { SettingsManager, getAgentDir, getMarkdownTheme, getSelectListTheme, initTheme } from '@earendil-works/pi-coding-agent';

// Pi publishes the active theme here so every loaded copy of its modules and components renders with it.
const activeTheme = () => globalThis[Symbol.for('@earendil-works/pi-coding-agent:theme')];
const rgbOf = ansi => {
  const match = /^\x1b\[38;2;(\d+);(\d+);(\d+)m$/.exec(ansi);
  return match ? match.slice(1).map(Number) : null;
};
const rgbTone = rgb => text => `\x1b[38;2;${rgb.join(';')}m${text}\x1b[39m`;

// An automatic `light/dark` setting uses Pi's terminal-background detection to choose its half.
const savedThemeName = cwd => {
  const setting = SettingsManager.create(cwd, getAgentDir()).getThemeSetting();
  const pair = typeof setting === 'string' ? setting.split('/') : [];
  if (pair.length !== 2) return setting;
  initTheme();
  return (activeTheme()?.name === 'light' ? pair[0] : pair[1]).trim();
};

const paletteFrom = theme => {
  const tone = token => text => theme.fg(token, text);
  const text = rgbOf(theme.getFgAnsi('text'));
  const muted = rgbOf(theme.getFgAnsi('muted'));
  // Secondary text sits halfway between body text and Pi's muted color, keeping a readable middle tier.
  const secondary = text && muted
    ? rgbTone(text.map((channel, index) => Math.round((channel + muted[index]) / 2)))
    : tone('muted');
  return {
    dim: secondary,
    muted: tone('muted'),
    faint: tone('borderMuted'),
    accent: tone('mdLink'),
    warning: tone('warning'),
    caution: tone('warning'),
    assistant: tone('mdHeading'),
    effort: level => theme.getThinkingBorderColor(level),
    highlight: tone('accent'),
    positive: tone('success'),
    negative: tone('error'),
    selection: theme.getBgAnsi('selectedBg'),
    gradient: [rgbOf(theme.getFgAnsi('accent')), rgbOf(theme.getFgAnsi('borderAccent'))],
    markdown: getMarkdownTheme(),
    select: getSelectListTheme(),
  };
};

/** The saved Pi theme's name and dashboard palette, or null when Pi cannot load that theme in this process. */
export function loadPiPalette(cwd) {
  try {
    const name = savedThemeName(cwd);
    if (!name) return null;
    initTheme(name);
    const theme = activeTheme();
    return theme?.name === name ? { name, palette: paletteFrom(theme) } : null;
  } catch {
    return null;
  }
}

/** Loads the saved Pi theme and reports later switches or edits until stopped. */
export function followPiTheme(cwd, onChange) {
  let loaded = loadPiPalette(cwd);
  let timer = null;
  const reload = () => {
    timer = null;
    const next = loadPiPalette(cwd);
    if (next) {
      loaded = next;
      onChange(next.palette);
    } else if (loaded) {
      // A failed load leaves Pi on its fallback; restore the last theme the dashboard is still showing.
      initTheme(loaded.name);
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(reload, 100);
    timer.unref?.();
  };
  const agentDir = getAgentDir();
  const watched = [
    { directory: agentDir, relevant: filename => !filename || filename === 'settings.json' },
    { directory: join(agentDir, 'themes'), relevant: () => true },
  ];
  const watchers = watched.flatMap(({ directory, relevant }) => {
    try {
      const watcher = watch(directory, (_event, filename) => {
        if (relevant(filename)) schedule();
      });
      watcher.on('error', () => watcher.close());
      watcher.unref();
      return [watcher];
    } catch {
      return [];
    }
  });
  return {
    palette: loaded?.palette ?? null,
    stop() {
      clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
    },
  };
}
