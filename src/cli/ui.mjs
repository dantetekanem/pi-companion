import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import {
  Editor, Markdown, ProcessTerminal, SelectList, TuiAltScreen, getKeybindings, matchesKey,
  stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import { followPiTheme } from './theme.mjs';

// The caller supplies already-loaded arrays; render never reads history or starts work.
const clean = value => stripTerminalSequences(String(value ?? '')).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
const line = (value, width) => truncateToWidth(value, Math.max(1, width));
const cell = (value, width) => {
  const text = line(value, width);
  return text + ' '.repeat(Math.max(0, width - visibleWidth(text)));
};
const wrapped = (value, width) => String(value ?? '').split('\n').flatMap(part =>
  wrapTextWithAnsi(clean(part), Math.max(1, width)));
const row = (left, right, width) => cell(left, Math.max(1, width - visibleWidth(right) - 2)) + '  ' + right;
const centered = (value, width) => ' '.repeat(Math.max(0, Math.floor((width - visibleWidth(value)) / 2))) + value;
const key = (data, name) => matchesKey(data, name);

const style = (open, close) => text => `\x1b[${open}m${text}\x1b[${close}m`;
const color = (...rgb) => style(`38;2;${rgb.join(';')}`, 39);
const bold = style(1, 22);
const pink = color(255, 121, 198);
const purple = color(189, 147, 249);
const cyan = color(139, 233, 253);
const green = color(80, 250, 123);
const orange = color(255, 184, 108);
const slate = color(157, 168, 186);
const comment = color(98, 114, 164);
const shadow = color(68, 71, 90);
// Dracula until the fullscreen dashboard loads the user's Pi theme (see theme.mjs for the same roles).
const builtInPalette = {
  dim: slate,
  muted: comment,
  faint: shadow,
  accent: cyan,
  warning: color(241, 250, 140),
  caution: orange,
  assistant: purple,
  effort: () => orange,
  highlight: pink,
  positive: green,
  negative: color(255, 85, 85),
  selection: '\x1b[48;2;68;71;90m',
  gradient: [[255, 121, 198], [189, 147, 249]],
  markdown: {
    heading: text => purple(bold(text)),
    link: cyan,
    linkUrl: comment,
    code: green,
    codeBlock: text => text,
    codeBlockBorder: shadow,
    quote: slate,
    quoteBorder: shadow,
    hr: shadow,
    listBullet: pink,
    bold,
    italic: style(3, 23),
    strikethrough: style(9, 29),
    underline: style(4, 24),
  },
  select: {
    selectedPrefix: pink,
    selectedText: text => pink(bold(text)),
    description: slate,
    scrollInfo: comment,
    noMatch: slate,
  },
};
let palette = builtInPalette;
const dim = text => palette.dim(text);
const muted = text => palette.muted(text);
const faint = text => palette.faint(text);
const accent = text => palette.accent(text);
const warning = text => palette.warning(text);
const caution = text => palette.caution(text);
const assistantColor = text => palette.assistant(text);
const effortTone = level => text => palette.effort(level)(text);
const highlight = text => palette.highlight(text);
const positive = text => palette.positive(text);
const negative = text => palette.negative(text);
// Open questions keep their list across theme changes, so the list theme reads the palette at render time.
const selectTheme = {
  selectedPrefix: text => palette.select.selectedPrefix(text),
  selectedText: text => palette.select.selectedText(text),
  description: text => palette.select.description(text),
  scrollInfo: text => palette.select.scrollInfo(text),
  noMatch: text => palette.select.noMatch(text),
};
const gradient = (value, from, to) => {
  const characters = [...value];
  const painted = characters.map((character, index) => {
    const ratio = index / Math.max(1, characters.length - 1);
    const channels = from.map((start, channel) => Math.round(start + (to[channel] - start) * ratio));
    return `\x1b[38;2;${channels.join(';')}m${character}`;
  });
  return `${painted.join('')}\x1b[39m`;
};
// 256-color themes have no RGB endpoints, so the name falls back to the solid accent.
const brand = () => {
  const [from, to] = palette.gradient;
  const name = from && to ? gradient('Pi Companion', from, to) : highlight('Pi Companion');
  return `${highlight('◆')} ${bold(name)}`;
};
// Re-open the background after resets so truncated, styled text keeps the selection bar intact.
const selectedRow = (value, width) => {
  const content = cell(value, width).replaceAll('\x1b[0m', `\x1b[0m${palette.selection}`);
  return `${palette.selection}${content}\x1b[49m`;
};
const spinner = at => '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[Math.floor(at / 100) % 10];
const spaced = () => muted('  ·  ');
const keys = pairs => pairs.map(([input, action]) => `${dim(input)} ${muted(action)}`).join(spaced());
const gauge = percent => {
  const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
  const tone = percent >= 80 ? negative : percent >= 50 ? caution : accent;
  return tone('━'.repeat(filled)) + faint('━'.repeat(10 - filled));
};
const noticeStyles = {
  error: ['✕', negative],
  warning: ['▲', caution],
  success: ['✓', positive],
};
const toned = (text, tone, frame) => {
  const [glyph, paint] = tone === 'progress' ? [frame, highlight] : noticeStyles[tone] ?? ['', dim];
  return paint(`${glyph ? `${glyph} ` : ''}${clean(text)}`);
};
const outcomes = {
  completed: ['●', positive],
  findings: ['●', positive],
  no_change: ['○', dim],
  incomplete: ['◐', caution],
  interrupted: ['◐', caution],
  failed: ['✕', negative],
  cancelled: ['○', muted],
  imported: ['◇', muted],
};
const outcome = value => Object.hasOwn(outcomes, value) ? outcomes[value] : ['•', dim];
const compactNumber = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const tokenCount = value => compactNumber.format(value).toLowerCase();

const pad = value => String(value).padStart(2, '0');
const until = (at, now) => {
  const minutes = (Date.parse(at) - now) / 60000;
  if (minutes <= 0) return 'due now';
  if (Math.round(minutes) < 1) return 'in <1m';
  if (Math.round(minutes) < 60) return `in ${Math.round(minutes)}m`;
  if (Math.round(minutes / 60) < 24) return `in ${Math.round(minutes / 60)}h`;
  return `in ${Math.round(minutes / 1440)}d`;
};
const every = minutes => {
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  if (minutes > 60) return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
  return `${minutes}m`;
};
const elapsed = (since, now) => {
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`;
};
const relativeTime = (at, now, elapsed = false) => {
  const seconds = (now - at) / 1000;
  const distance = Math.abs(seconds);
  const unit = distance < 60 ? 'second' : distance < 3600 ? 'minute' : distance < 86400 ? 'hour' : 'day';
  const amount = Math.floor(distance / ({ second: 1, minute: 60, hour: 3600, day: 86400 }[unit]));
  const label = `${amount} ${unit}${amount === 1 ? '' : 's'}`;
  return elapsed ? seconds < 0 ? 'start is in the future' : `${label} elapsed`
    : seconds < 0 ? `in ${label}` : `${label} ago`;
};
const fixedTime = at => {
  const date = new Date(at);
  const zone = new Intl.DateTimeFormat('en', { timeZoneName: 'short' }).formatToParts(date)
    .find(part => part.type === 'timeZoneName').value;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${zone}`;
};
const timestamp = (value, now, elapsed = false) => {
  const at = typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? `${relativeTime(at, now, elapsed)} · ${fixedTime(at)}`
    : '';
};
const timeOf = value => {
  let at = NaN;
  if (typeof value === 'number') at = value;
  else if (typeof value === 'string' && value.trim()) at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
};
const dayOf = at => at === null ? null : new Date(at).toDateString();
const clockTime = at => {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const dayLabel = (at, now) => {
  const date = new Date(at);
  const today = new Date(now);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  const year = date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' };
  return new Intl.DateTimeFormat('en', { weekday: 'short', month: 'short', day: 'numeric', ...year }).format(date);
};
// A report's first substantive line, skipping rules, generic headings and lines that repeat its title.
const summaryOf = report => {
  const title = clean(report.title).trim().toLowerCase();
  for (const source of String(report.body ?? '').slice(0, 4000).split('\n')) {
    const text = clean(source)
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\*\*|__|`|~~/g, '')
      .replace(/^\s*(#{1,6}|[-*+>]|\d+[.)])\s+/, '')
      .replace(/\s+/g, ' ')
      .trim();
    const isRule = /^[-=_*\s]+$/.test(text);
    const repeatsTitle = Boolean(title) && text.toLowerCase().includes(title);
    if (text.length >= 12 && !isRule && !repeatsTitle) return text;
  }
  return '';
};

const boxed = ({ paint, top = '', bottom = '', lines, inner }) => {
  const edge = (start, label, end) => paint(`${start}${label ? '─ ' : ''}`) + (label ? `${label} ` : '')
    + paint('─'.repeat(Math.max(0, inner - 2 - (label ? visibleWidth(label) + 3 : 0))) + end);
  const sides = lines.map(value => `${paint('│')} ${cell(value, inner - 4)} ${paint('│')}`);
  return [edge('╭', top, '╮'), ...sides, edge('╰', bottom, '╯')];
};
const tabText = ({ label, count = '', prefix = '' }, active) => {
  const name = active ? highlight(bold(label)) : dim(label);
  const badge = count ? ` ${active ? highlight(count) : muted(count)}` : '';
  const text = `${prefix}${name}${badge}`;
  return { text, active, width: visibleWidth(text) };
};
// Tabs share the brand row when everything fits; otherwise they get a row windowed around the active tab.
const headerLines = ({ tabs, status, inner }) => {
  const span = (from, to) => tabs.slice(from, to + 1).reduce((sum, tab) => sum + tab.width, 0) + 3 * (to - from);
  const activeTab = Math.max(0, tabs.findIndex(tab => tab.active));
  const brandText = brand();
  const brandWidth = visibleWidth(brandText);
  const inline = brandWidth + 4 + span(0, tabs.length - 1) + 2 + visibleWidth(status) <= inner;
  let first = 0;
  let last = tabs.length - 1;
  if (span(first, last) > inner) {
    first = activeTab;
    last = activeTab;
    for (let grown = true; grown;) {
      grown = false;
      if (last + 1 < tabs.length && span(first, last + 1) <= inner - 4) {
        last++;
        grown = true;
      }
      if (first > 0 && span(first - 1, last) <= inner - 4) {
        first--;
        grown = true;
      }
    }
  }
  const before = first > 0 ? muted('‹ ') : '';
  const after = last < tabs.length - 1 ? muted(' ›') : '';
  const tabRow = before + tabs.slice(first, last + 1).map(tab => tab.text).join('   ') + after;
  const underlineStart = (inline ? brandWidth + 4 : 0) + visibleWidth(before) + span(first, activeTab) - tabs[activeTab].width;
  const underlineWidth = Math.min(tabs[activeTab].width, Math.max(0, inner - underlineStart));
  const underline = faint('─'.repeat(underlineStart)) + highlight('━'.repeat(underlineWidth))
    + faint('─'.repeat(Math.max(0, inner - underlineStart - underlineWidth)));
  const titleRows = inline ? [row(`${brandText}    ${tabRow}`, status, inner)] : [row(brandText, status, inner), tabRow];
  return [...titleRows, underline];
};
const modelLabel = (effort, model, withProvider) => {
  const provider = model.lastIndexOf('/');
  const prefix = withProvider && provider > 0 ? muted(model.slice(0, provider + 1)) : '';
  return [
    effort ? effortTone(effort)(bold(clean(effort))) : '',
    model ? `${prefix}${assistantColor(model.slice(provider + 1))}` : '',
  ].filter(Boolean).join(' ');
};
const contextLabel = (context, withGauge) => {
  const percent = Number.isFinite(context?.percent)
    ? `${withGauge ? `${gauge(context.percent)} ` : ''}${dim(`${Math.round(context.percent)}%`)}` : '';
  const usage = Number.isFinite(context?.tokens)
    ? `~${tokenCount(context.tokens)}${Number.isFinite(context.contextWindow) ? `/${tokenCount(context.contextWindow)}` : ''}` : '';
  const details = [
    percent,
    usage ? muted(usage) : '',
    context?.auto === false ? caution('auto-compact off') : '',
    context?.compactions ? muted(`compacted ${context.compactions}`) : '',
  ].filter(Boolean);
  return details.length ? `${muted('context')}  ${details.join(spaced())}` : '';
};

const jobDetails = (run, clock) => {
  const started = timeOf(run.startedAt);
  return [
    run.harness ? dim(clean(run.harness)) : '',
    run.model ? assistantColor(clean(run.model)) : '',
    run.effort ? effortTone(run.effort)(clean(run.effort)) : '',
    started === null ? '' : muted(`started ${relativeTime(started, clock)}`),
  ].filter(Boolean).join(muted(' · '));
};
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const scheduleWhen = (schedule, clock) => {
  const zone = schedule.timezone ? new Intl.DateTimeFormat('en-US', {
    timeZone: schedule.timezone, timeZoneName: 'shortGeneric',
  }).formatToParts(clock).find(part => part.type === 'timeZoneName').value : '';
  const legacy = schedule.legacy?.legacy;
  if (legacy) return `${legacy.type} ${legacy.schedule}`;
  const times = schedule.window
    ? `${schedule.window.start}–${schedule.window.end} ${zone} · every ${every(schedule.window.everyMinutes)}`
    : `${Array.isArray(schedule.at) ? schedule.at.join(', ') : schedule.at} ${zone}`;
  return [
    schedule.cadence,
    schedule.weekday == null ? '' : weekdays[schedule.weekday],
    schedule.day == null ? '' : `day ${schedule.day}`,
    times,
  ].filter(Boolean).join(' · ');
};
const lifecycleLabels = {
  completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', expired: 'Expired',
  paused: 'Paused', pending: 'Awaiting scheduler', blocked: 'Invalid schedule',
};
const scheduleStatus = ({ schedule, jobs, live, clock, frame }) => {
  if (jobs.length) return { timing: 'running now', tone: positive, glyph: positive(frame) };
  if (!schedule.enabled) return { timing: 'paused', tone: caution, glyph: muted('○') };
  if (schedule.nextRun?.at) return { timing: until(schedule.nextRun.at, clock), tone: accent, glyph: accent('●') };
  if (schedule.nextRun?.state === 'running') {
    return live
      ? { timing: 'running now', tone: positive, glyph: positive(frame) }
      : { timing: 'Activity unavailable (saved state)', tone: dim, glyph: muted('◌') };
  }
  const { reason, state } = schedule.nextRun ?? {};
  const timing = reason ? reason.replaceAll('_', ' ') : lifecycleLabels[state] ?? '';
  if (['blocked', 'failed', 'cancelled'].includes(state)) return { timing, tone: negative, glyph: negative('✕') };
  return { timing, tone: dim, glyph: muted('◌') };
};
const scheduleLines = ({ schedules, counts, diagnostics, activeRuns, live, inner, clock, frame }) => {
  const totals = [
    `${counts.daily ?? 0} daily`, `${counts.weekly ?? 0} weekly`, `${counts.monthly ?? 0} monthly`,
    counts.compatibility ? `${counts.compatibility} migrated` : '',
  ].filter(Boolean).join(' · ');
  const content = [muted(totals), ''];
  for (const diagnostic of diagnostics) {
    const lines = wrapped(diagnostic.title, inner - 2);
    content.push(...lines.map((value, index) => `${index ? ' ' : negative('✕')} ${warning(value)}`), '');
  }

  const hasActiveRun = schedule => activeRuns.some(run => run.scheduleId === schedule.id);
  const nextAt = schedule => schedule.enabled && schedule.nextRun?.at ? Date.parse(schedule.nextRun.at) : Infinity;
  const ordered = schedules.toSorted((left, right) =>
    Number(hasActiveRun(right)) - Number(hasActiveRun(left)) || nextAt(left) - nextAt(right) || 0);
  const items = ordered.map(schedule => {
    const jobs = activeRuns.filter(run => run.scheduleId === schedule.id);
    const when = scheduleWhen(schedule, clock);
    const { timing, tone, glyph } = scheduleStatus({ schedule, jobs, live, clock, frame });
    return {
      jobs,
      glyph,
      tone,
      title: clean(schedule.title),
      when: clean(when),
      timing: clean(timing),
    };
  });

  // Columns take their natural widths; narrow terminals stack each schedule instead of truncating both.
  const timingWidth = Math.max(0, ...items.map(item => visibleWidth(item.timing)));
  const naturalWhen = Math.max(0, ...items.map(item => visibleWidth(item.when)));
  const naturalTitle = Math.max(0, ...items.map(item => visibleWidth(item.title)));
  const room = inner - 2 - timingWidth - 4;
  const whenWidth = Math.min(naturalWhen, Math.max(12, room - Math.min(naturalTitle, 24)));
  const titleWidth = room - whenWidth;
  const table = titleWidth >= Math.min(naturalTitle, 24) && whenWidth >= Math.min(naturalWhen, 24);
  if (table && items.length) {
    content.push(muted(`  ${cell('SCHEDULE', titleWidth)}  ${cell('WHEN', whenWidth)}  ${'NEXT'.padStart(timingWidth)}`), '');
  }
  for (const item of items) {
    if (table) {
      const timingPadding = ' '.repeat(timingWidth - visibleWidth(item.timing));
      content.push(`${item.glyph} ${cell(bold(item.title), titleWidth)}  ${cell(dim(item.when), whenWidth)}  ${timingPadding}${item.tone(item.timing)}`);
    } else {
      content.push(`${item.glyph} ${row(bold(item.title), item.tone(item.timing), inner - 2)}`);
      content.push(...wrapped(item.when, inner - 2).map(value => `  ${dim(value)}`));
    }
    for (const run of item.jobs) {
      content.push(...wrapTextWithAnsi(jobDetails(run, clock), inner - 2).map(value => `  ${value}`));
    }
    content.push('');
  }

  const scheduleIds = new Set(schedules.map(schedule => schedule.id));
  for (const run of activeRuns.filter(item => !scheduleIds.has(item.scheduleId))) {
    content.push(
      '',
      warning(`▲ Orphan scheduled job · ${clean(run.scheduleId)}`),
      `${positive(frame)} ${positive(bold(clean(run.title ?? run.id)))}`,
      ...wrapTextWithAnsi(jobDetails(run, clock), inner - 2).map(value => `  ${value}`),
    );
  }
  if (!schedules.length) content.push(dim('No schedules yet. Add a file to schedules/daily, weekly or monthly.'));
  return content;
};
const toolState = (state, frame) => {
  if (state === 'failed') return ['✕', negative];
  if (state === 'completed') return ['✓', positive];
  return [frame, highlight];
};
const jobActivityLines = ({ run, blocks, inner, clock, frame, markdown }) => {
  const content = [];
  if (run) {
    content.push(...wrapTextWithAnsi(`${positive(frame)} ${bold(clean(run.title ?? ''))}  ${jobDetails(run, clock)}`, inner), '');
  }
  for (const block of blocks) {
    if (block.kind === 'assistant' && clean(block.text).trim()) {
      content.push(assistantColor(bold('◆ Companion')), ...markdown(block.text, inner - 2).map(value => `  ${value}`), '');
    } else if (block.kind === 'tool') {
      const [glyph, tone] = toolState(block.state, frame);
      content.push(`${tone(glyph)} ${bold(clean(block.name))} ${muted(clean(block.state))}`);
      if (block.input) content.push(...wrapped(block.input, inner - 2).map(value => `  ${accent(value)}`));
      if (block.output) content.push(...wrapped(block.output, inner - 2).map(value => `  ${dim(value)}`));
      content.push('');
    }
  }
  if (!blocks.length) content.push(dim('No parent activity received yet.'));
  return content;
};
// Critical and useful report messages read as messages; other notices stay quiet.
const noticeLooks = {
  critical: ['▲', caution, text => text],
  useful: ['●', positive, text => text],
};
// Consecutive identical report notices from the same day collapse into one entry that keeps the latest time.
const chatEntries = messages => {
  const entries = [];
  for (const message of messages) {
    const at = timeOf(message.at);
    const previous = entries.at(-1);
    const repeatsNotice = message.role === 'notice' && previous?.message.role === 'notice'
      && clean(previous.message.content) === clean(message.content) && dayOf(previous.at) === dayOf(at);
    if (repeatsNotice) {
      previous.repeats++;
      if (at !== null) previous.latest = at;
    } else {
      entries.push({ message, at, latest: at, repeats: 1 });
    }
  }
  return entries;
};
const chatLines = ({ messages, inner, clock, markdown }) => {
  const entries = chatEntries(messages);
  const content = [];
  let day = null;
  entries.forEach(({ message, at, latest, repeats }, index) => {
    if (at !== null && dayOf(at) !== day) {
      day = dayOf(at);
      content.push(centered(`${faint('──')} ${muted(dayLabel(at, clock))} ${faint('──')}`, inner), '');
    }
    const time = at === null ? '' : muted(clockTime(at));
    if (message.role === 'notice') {
      const label = `${clean(message.content)}${repeats > 1 ? ` ×${repeats}` : ''}`;
      const latestTime = latest === null ? '' : muted(clockTime(latest));
      const [glyph, paintGlyph, paintText] = noticeLooks[message.tone] ?? ['◇', muted, dim];
      content.push(...wrapped(label, inner - 9).map((value, part) =>
        part ? `  ${paintText(value)}` : `${paintGlyph(glyph)} ${row(paintText(value), latestTime, inner - 2)}`));
      const following = entries[index + 1];
      if (following?.message.role !== 'notice' || dayOf(following.at) !== dayOf(at)) content.push('');
      return;
    }
    if (message.role === 'user') {
      content.push(...markdown(message.content, inner - 9).map((value, part) =>
        `${accent('┃')} ${part || !time ? value : row(value, time, inner - 2)}`));
    } else {
      const author = message.role === 'assistant' ? assistantColor(bold('◆ Companion')) : muted(bold(`◇ ${clean(message.role)}`));
      content.push(row(author, time, inner), ...markdown(message.content, inner - 2).map(value => `  ${value}`));
    }
    content.push('');
  });
  return content;
};
const welcomeLines = (inner, available) => {
  const welcome = [
    `${highlight('◆')}  ${bold('What would you like to work on?')}`,
    '',
    ...wrapped('Message your agent below. Reports from scheduled checks appear in Reports.', Math.min(inner, 64)).map(dim),
    '',
    keys([['←→', 'switch views'], ['/clear', 'hide visible chat'], ['/reset', 'fresh context']]),
  ];
  const topPadding = Math.max(0, Math.floor((available - welcome.length) / 2));
  return [...Array(topPadding).fill(''), ...welcome.map(value => centered(value, inner))];
};
const reportListLines = ({ reports, total, selectedId, inner, clock }) => {
  const content = [];
  const ranges = [];
  let day;
  reports.forEach((report, index) => {
    const at = timeOf(report.at);
    const startsDay = !index || dayOf(at) !== day;
    // One blank line separates reports; days get a wider gap so the grouping reads at a glance.
    if (index) content.push('');
    if (startsDay) {
      day = dayOf(at);
      if (index) content.push('');
    }
    const start = content.length;
    if (startsDay) {
      const label = muted(bold((at === null ? 'Undated' : dayLabel(at, clock)).toUpperCase()));
      const count = reports.length < total ? `latest ${reports.length} of ${total}`
        : `${reports.length} report${reports.length === 1 ? '' : 's'}`;
      content.push(index ? label : row(label, muted(count), inner), '');
    }
    const isSelected = report.id === selectedId;
    const [glyph, tone] = outcome(report.outcome);
    const title = clean(report.title);
    const summary = summaryOf(report);
    const lines = [`${tone(glyph)} ${row(isSelected ? highlight(bold(title)) : title, dim(at === null ? '' : clockTime(at)), inner - 4)}`];
    if (summary) lines.push(`  ${dim(summary)}`);
    content.push(...lines.map(value => isSelected ? selectedRow(`${highlight('▌')} ${value}`, inner) : `  ${value}`));
    ranges.push([start, content.length]);
  });
  if (!reports.length) content.push(dim('No reports yet.'));
  return { content, ranges };
};
const reportDetailLines = ({ report, inner, clock, markdown }) => {
  if (!report) return [dim('No report selected.')];
  const [glyph, tone] = outcome(report.outcome);
  const when = timestamp(report.at, clock);
  const meta = [
    report.outcome ? tone(`${glyph} ${clean(report.outcome).replaceAll('_', ' ')}`) : '',
    when ? dim(when) : '',
  ].filter(Boolean).join(muted(' · '));
  const provenance = report.origin ? [
    ...wrapped([report.readState, report.provider ? `provider ${report.provider}` : '', report.origin].filter(Boolean).join(' · '), inner).map(muted),
    ...wrapped(`Source: ${report.path}${report.truncated ? ' (preview truncated)' : ''}`, inner),
  ] : [];
  return [
    ...wrapped(report.title, inner).map(bold),
    ...(meta ? wrapTextWithAnsi(meta, inner) : []),
    ...provenance,
    faint('─'.repeat(inner)),
    '',
    ...markdown(report.body, inner),
  ];
};
const viewport = ({ content, offset, available, inner }) => {
  const visible = content.slice(offset, offset + available);
  return Array.from({ length: available }, (_, index) => `  ${line(visible[index] ?? '', inner)}`);
};

// The dashboard draws the composer box; the editor only reports how many lines are scrolled away.
class Composer extends Editor {
  renderTopBorder(_width, hidden) { return hidden > 0 ? `↑ ${hidden} more` : ''; }
  renderBottomBorder(_width, hidden) { return hidden > 0 ? `↓ ${hidden} more` : ''; }
}

export function createDashboard(initial, handlers = {}, options = {}) {
  let snapshot = initial;
  let callbacks = handlers;
  let selectedId = snapshot.reports?.[0]?.id ?? null;
  let completedReport = null;
  let focus = 'composer';
  let view = 'conversation';
  let scroll = 0;
  let listTop = 0;
  let rows = 24;
  let columns = 80;
  let contentBounds = { top: 0, bottom: 0 };
  let hasFocus = true;
  let question = null;
  let notice = '';
  let noticeTone = 'info';
  let noticeTimer = null;
  let busySince = null;
  let ticker = null;
  let hiddenMessages = new Set(snapshot.presentation?.hiddenMessageIds ?? []);
  const messageKey = message => message.id ?? JSON.stringify(message);
  const visibleMessageIds = () => (snapshot.messages ?? [])
    .filter(message => !hiddenMessages.has(messageKey(message)) && clean(message.content).trim())
    .map(messageKey);
  let pending = Promise.resolve();
  let clearing = false;
  let stopped = false;
  const onChange = options.onChange ?? (() => {});
  const now = () => (options.now ?? Date.now)();
  // A newer notice always cancels a pending timeout, so it never erases what replaced it.
  const say = (text, tone = 'info', { timeout } = {}) => {
    notice = text;
    noticeTone = tone;
    clearTimeout(noticeTimer);
    noticeTimer = null;
    if (!timeout) return;

    noticeTimer = setTimeout(() => {
      say('');
      changed();
    }, timeout);
    noticeTimer.unref?.();
  };
  const reports = () => (snapshot.reports ?? []).slice(0, 25);
  const allReports = () => snapshot.reports ?? [];
  const liveJobs = () => snapshot.connection === 'connected' ? (snapshot.runs ?? []).filter(run =>
    run.state === 'running' && run.kind === 'background'
    && typeof run.scheduleId === 'string' && run.scheduleId.trim()) : [];
  const invalidSchedules = () => (snapshot.runs ?? []).filter(run => run.state === 'invalid');
  const views = () => ['conversation', 'reports', 'schedules', ...liveJobs().map(run => `job:${run.id}`)];
  const isJob = () => view.startsWith('job:');
  const followsTail = () => view === 'conversation' || isJob();
  const showsReportList = () => view === 'reports' && (question?.previous.focus ?? focus) === 'reports';
  const selectedIndex = () => Math.max(0, reports().findIndex(report => report.id === selectedId));
  const changed = () => { if (!stopped) onChange(); };
  const connected = () => snapshot.connection === 'connected' && typeof callbacks.send === 'function';
  // Spinners and elapsed time only need frames while the main turn, compaction or a job is running.
  const animate = () => {
    const live = snapshot.connection === 'connected';
    busySince = live && snapshot.busy ? busySince ?? now() : null;
    const active = !stopped && live && Boolean(snapshot.busy || snapshot.context?.compacting || liveJobs().length);
    if (active && !ticker) {
      ticker = setInterval(changed, 100);
      ticker.unref?.();
    } else if (!active && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  };

  const editor = new Composer(options.tui ?? {
    terminal: { get rows() { return rows; } },
    requestRender: changed,
  }, { borderColor: accent, selectList: selectTheme });
  editor.onChange = changed;
  for (const message of snapshot.messages ?? []) {
    if (message.role === 'user') editor.addToHistory(message.content);
  }
  editor.onSubmit = submitted => {
    // Editor clears before onSubmit; keep the draft until the runtime accepts it.
    editor.setText(submitted);
    if (submitted.startsWith('/')) {
      if (!['/clear', '/reset'].includes(submitted)) {
        say('Unknown command. Use /clear or /reset.', 'warning');
        changed();
        return;
      }
      if (clearing) return;
      if (submitted === '/reset') {
        clearing = true;
        pending = Promise.resolve().then(() => {
          if (typeof callbacks.reset !== 'function') throw Error('Reset unavailable');
          return callbacks.reset();
        }).then(() => {
          if (editor.getExpandedText() === submitted) editor.setText('');
          say('Main context reset.', 'success');
        }, error => { say(`Reset failed: ${clean(error?.message ?? error)}`, 'error'); })
          .finally(() => { clearing = false; changed(); });
        return;
      }
      const messageIds = visibleMessageIds();
      clearing = true;
      pending = Promise.resolve().then(() => typeof callbacks.clear === 'function'
        ? callbacks.clear(messageIds)
        : { hiddenMessageIds: [...hiddenMessages, ...messageIds] })
        .then(result => {
          hiddenMessages = new Set([...hiddenMessages, ...(result?.hiddenMessageIds ?? messageIds)]);
          scroll = 0;
          if (editor.getExpandedText() === submitted) editor.setText('');
          say('Visible chat cleared; context and history kept.', 'success', { timeout: 3000 });
        }, error => {
          if (!editor.getExpandedText()) editor.setText(submitted);
          say(`Clear failed: ${clean(error?.message ?? error)}`, 'error');
        })
        .finally(() => {
          clearing = false;
          changed();
        });
      return;
    }
    if (!submitted.trim() || clearing) return;
    if (!connected()) {
      say('Offline — send unavailable until the main conversation connects', 'warning');
      changed();
      return;
    }
    say('Sending…', 'progress');
    pending = Promise.resolve().then(() => callbacks.send(submitted)).then(() => {
      if (editor.getExpandedText() === submitted) editor.setText('');
      editor.addToHistory(submitted);
      view = 'conversation';
      focus = 'composer';
      scroll = 0;
      say('');
    }, error => {
      say(`Send failed: ${clean(error?.message ?? error)}`, 'error');
    }).finally(() => {
      changed();
    });
  };

  const documents = new Map();
  const markdown = (value, width) => {
    const text = String(value ?? '').split('\n').map(clean).join('\n');
    if (!documents.has(text)) {
      if (documents.size >= 128) documents.delete(documents.keys().next().value);
      documents.set(text, new Markdown(text, 0, 0, palette.markdown));
    }
    return documents.get(text).render(width);
  };

  const jobTitle = run => run.title
    || snapshot.schedules?.find(schedule => schedule.id === run.scheduleId)?.title
    || 'Background job';
  const renderHeader = (inner, clock, frame) => {
    const live = snapshot.connection === 'connected';
    const activeRuns = liveJobs();
    const indicator = !live ? muted('○') : snapshot.busy ? highlight(frame) : positive('●');
    const working = busySince ? `working ${elapsed(busySince, clock)}` : 'working';
    const connection = live && snapshot.busy ? working : clean(snapshot.connection ?? 'offline');
    const status = [
      `${indicator} ${dim(connection)}`,
      activeRuns.length ? positive(`${activeRuns.length} running`) : '',
    ].filter(Boolean).join(dim(' · '));
    const scheduleCount = Object.values(snapshot.counts ?? {}).reduce((sum, count) => sum + count, 0);
    const tabs = [
      { name: 'conversation', label: 'Chat' },
      { name: 'reports', label: 'Reports', count: String(allReports().length) },
      { name: 'schedules', label: 'Schedules', count: String(scheduleCount) },
      ...activeRuns.map(run => ({ name: `job:${run.id}`, label: line(clean(jobTitle(run)), 24), prefix: `${positive(frame)} ` })),
    ].map(tab => tabText(tab, tab.name === view));
    const header = headerLines({ tabs, status, inner });
    const invalid = invalidSchedules().length;
    if (invalid) header.push(warning(`▲ ${invalid} invalid schedule${invalid === 1 ? '' : 's'} · see Schedules`));
    return [...header, ''];
  };

  const hintsFor = draft => {
    if (question) return [['↑↓', 'choose'], ['enter', 'answer'], ['esc', 'cancel'], ['pgup/pgdn', 'read']];
    if (isJob()) return [['k', 'cancel job'], ['pgup/pgdn', 'scroll'], ['←→', 'views'], ['esc', 'chat']];
    if (focus === 'reports') return [['↑↓', 'select'], ['enter', 'read'], ['←→', 'views'], ['esc', 'chat']];
    if (focus === 'detail') return [['↑↓ pgup/pgdn', 'scroll'], ['esc', 'back'], ['←→', 'views']];
    if (focus === 'schedules') return [['↑↓ pgup/pgdn', 'scroll'], ['←→', 'views'], ['esc', 'chat']];
    if (draft.startsWith('/')) return [['/clear', 'hide visible chat'], ['/reset', 'start a fresh main context']];
    if (draft) return [['enter', 'send'], ['ctrl+j', 'newline'], ['ctrl+c', 'quit']];
    return [['enter', 'send'], ['↑', 'history'], ['←→', 'views'], ['/', 'commands'], ['ctrl+c', 'quit']];
  };
  const nextCheck = (inner, clock) => {
    const schedules = snapshot.schedules ?? [];
    const upcoming = schedules.filter(schedule => schedule.enabled && schedule.nextRun?.at)
      .toSorted((a, b) => Date.parse(a.nextRun.at) - Date.parse(b.nextRun.at))[0];
    let detail;
    if (snapshot.connection !== 'connected') detail = muted('waiting for connection');
    else if (upcoming) {
      const title = line(clean(upcoming.title), Math.max(12, inner - 24));
      detail = `${assistantColor(title)}  ${accent(until(upcoming.nextRun.at, clock))}`;
    } else if (schedules.some(schedule => schedule.enabled)) detail = muted('no run scheduled');
    else if (schedules.length) detail = negative('none · all schedules paused');
    else detail = muted('no schedules');
    return `${muted('next check')}   ${detail}`;
  };
  const activityText = (hints, frame) => {
    if (notice) return toned(notice, noticeTone, frame);
    if (snapshot.error) return toned(snapshot.error, 'error', frame);
    if (question || focus !== 'composer') return hints;
    if (snapshot.context?.compacting && connected()) return highlight(`${frame} Compacting…`);
    if (!connected()) return toned('Offline — send unavailable', 'warning', frame);
    return hints;
  };
  const sessionBar = inner => {
    const { main = {} } = snapshot.config ?? {};
    const effort = snapshot.main?.effort ?? main.effort;
    const model = clean(snapshot.main?.model ?? main.model ?? '');
    const cost = Number.isFinite(snapshot.usage?.usd) ? accent(`$${snapshot.usage.usd.toFixed(2)} est.`) : '';
    const variants = [[true, true], [true, false], [false, false]].map(([withProvider, withGauge]) =>
      [modelLabel(effort, model, withProvider), contextLabel(snapshot.context, withGauge)].filter(Boolean).join('     '));
    const session = variants.find(value => visibleWidth(value) + visibleWidth(cost) + 2 <= inner)
      ?? modelLabel(effort, model, false);
    return row(session, cost, inner);
  };
  const composerBox = inner => {
    const [above, ...lines] = editor.render(inner - 6);
    const below = lines.pop();
    const paint = editor.focused && connected() ? assistantColor : muted;
    const placeholder = connected() ? 'Message Companion…' : 'Waiting for the main conversation…';
    const empty = !editor.getExpandedText();
    const content = lines.map((value, index) => {
      const prompt = index ? '  ' : `${connected() ? highlight('❯') : muted('❯')} `;
      return prompt + (empty && !index ? value.trimEnd() + muted(placeholder) : value);
    });
    return boxed({ paint, top: above && muted(above), bottom: below && muted(below), lines: content, inner });
  };
  const questionBox = (inner, height, headerLength) => {
    const choices = question.selection.render(inner - 4);
    const label = question.selection.getSelectedItem()?.label ?? '';
    // The list truncates long choices, so the selected one is also readable in full above it.
    const fullChoice = visibleWidth(clean(label)) > inner - 6 ? ['', ...wrapped(label, inner - 4).map(accent)] : [];
    const text = [...wrapped(question.question, inner - 4).map(bold), ...fullChoice];
    const capacity = Math.max(1, Math.min(Math.floor((height - headerLength) / 2),
      height - headerLength - choices.length - 10));
    question.scroll = Math.min(question.scroll, Math.max(0, text.length - capacity));
    const visibleText = text.slice(question.scroll, question.scroll + capacity);
    return boxed({ paint: highlight, top: highlight(bold('Companion asks')), lines: [...visibleText, '', ...choices], inner });
  };
  const renderFooter = (inner, height, headerLength, clock, frame) => {
    editor.focused = hasFocus && focus === 'composer';
    const hints = hintsFor(editor.getExpandedText());
    // Drop whole hints from the end rather than cutting one mid-word.
    let shown = hints.length;
    while (shown > 1 && visibleWidth(keys(hints.slice(0, shown))) + 2 > inner) shown--;
    const activity = activityText(keys(hints.slice(0, shown)), frame);
    const statusLines = [`  ${activity}`, '', nextCheck(inner, clock), sessionBar(inner)];
    if (question) return [...questionBox(inner, height, headerLength), ...statusLines];
    if (view === 'conversation') return [...composerBox(inner), ...statusLines];
    return ['', ...statusLines];
  };
  const renderContent = (inner, available, clock, frame) => {
    const live = snapshot.connection === 'connected';
    const activeRuns = liveJobs();
    if (view === 'schedules') {
      return {
        content: scheduleLines({
          schedules: snapshot.schedules ?? [],
          counts: snapshot.counts ?? {},
          diagnostics: invalidSchedules(),
          activeRuns,
          live,
          inner,
          clock,
          frame,
        }),
      };
    }
    if (isJob()) {
      return {
        content: jobActivityLines({
          run: activeRuns.find(run => `job:${run.id}` === view),
          blocks: snapshot.jobActivity?.[view.slice(4)] ?? [],
          inner,
          clock,
          frame,
          markdown,
        }),
      };
    }
    if (view === 'conversation') {
      const messages = (snapshot.messages ?? []).filter(message =>
        !hiddenMessages.has(messageKey(message)) && clean(message.content).trim());
      const content = chatLines({ messages, inner, clock, markdown });
      return { content: content.length ? content : welcomeLines(inner, available) };
    }
    if (showsReportList()) {
      return reportListLines({ reports: reports(), total: allReports().length, selectedId, inner, clock });
    }
    return {
      content: reportDetailLines({ report: completedReport ?? reports()[selectedIndex()], inner, clock, markdown }),
    };
  };

  const controller = {
    state: () => ({ selectedId, focus, view, scroll, draft: editor.getExpandedText(), notice }),
    get focused() { return hasFocus; },
    set focused(value) { hasFocus = value; },
    pending: () => pending,
    setHandlers(next) {
      callbacks = next;
      changed();
    },
    update(next) {
      snapshot = next;
      for (const id of next.presentation?.hiddenMessageIds ?? []) hiddenMessages.add(id);
      const target = question?.previous ?? { view, focus, scroll };
      if (target.view.startsWith('job:') && !views().includes(target.view)) {
        completedReport = next.completedJobReports?.[target.view.slice(4)] ?? null;
        if (completedReport) selectedId = completedReport.id;
        target.view = completedReport ? 'reports' : 'conversation';
        target.focus = completedReport ? 'detail' : 'composer';
        target.scroll = 0;
      }
      if (!question) {
        ({ view, focus, scroll } = target);
      } else {
        view = target.view;
      }
      if (!completedReport && !reports().some(report => report.id === selectedId)) selectedId = reports()[0]?.id ?? null;
      animate();
      changed();
    },
    invalidate() {
      editor.invalidate();
      documents.clear();
    },
    askQuestion(request, signal) {
      if (stopped || question) return Promise.resolve(undefined);
      if (signal?.aborted) return Promise.resolve(null);
      return new Promise(resolve => {
        const previous = { focus, view, scroll };
        const selection = new SelectList(request.choices, 3, selectTheme);
        const current = { ...request, selection, finish, previous, scroll: 0 };
        function finish(value) {
          if (question !== current) return;
          signal?.removeEventListener('abort', cancel);
          question = null;
          ({ focus, view, scroll } = previous);
          resolve(value);
          changed();
        }
        const cancel = () => finish(null);
        selection.onSelectionChange = () => { current.scroll = 0; };
        selection.onSelect = item => finish(item.value);
        selection.onCancel = cancel;
        signal?.addEventListener('abort', cancel, { once: true });
        question = current;
        focus = 'question';
        changed();
      });
    },
    stop() {
      stopped = true;
      clearTimeout(noticeTimer);
      animate();
      question?.finish(null);
    },
    handleMouse(event) {
      if (event.type !== 'wheel' || question) return;
      if (event.y >= contentBounds.top && event.y < contentBounds.bottom && focus !== 'reports') {
        const delta = (event.wheelDelta ?? 0) * (followsTail() ? -1 : 1);
        scroll = Math.max(0, scroll + delta);
        changed();
      }
      return { handled: true };
    },
    input(data) {
      if (key(data, 'ctrl+c')) {
        callbacks.onQuit?.();
        return;
      }
      if (question) {
        const tooSmall = (options.tui?.terminal.columns ?? columns) < 60 || (options.tui?.terminal.rows ?? rows) < 18;
        if (key(data, 'escape')) question.finish(null);
        else if (!tooSmall && (key(data, 'pageUp') || key(data, 'pageDown'))) {
          question.scroll = Math.max(0, question.scroll + (key(data, 'pageDown') ? 2 : -2));
        } else if (!tooSmall) question.selection.handleInput(data);
        changed();
        return;
      }
      if (data === 'k' && isJob()) {
        const runId = view.slice(4);
        say('Requesting cancellation…', 'progress');
        pending = Promise.resolve().then(() => {
          if (typeof callbacks.kill !== 'function') throw Error('Kill unavailable');
          return callbacks.kill(runId);
        }).then(accepted => {
          if (accepted) say('Cancellation accepted.', 'success');
          else say('No owned running job.', 'warning');
        }, error => { say(`Kill failed: ${clean(error?.message ?? error)}`, 'error'); })
          .finally(changed);
      } else if ((key(data, 'left') || key(data, 'right'))
        && (view !== 'conversation' || !editor.getExpandedText())) {
        const tabs = views();
        const direction = key(data, 'left') ? -1 : 1;
        view = tabs[(tabs.indexOf(view) + direction + tabs.length) % tabs.length];
        if (view === 'conversation') {
          focus = 'composer';
        } else if (isJob()) {
          focus = 'job';
        } else {
          focus = view;
        }
        if (view === 'reports') completedReport = null;
        if (!completedReport && !reports().some(report => report.id === selectedId)) {
          selectedId = reports()[0]?.id ?? null;
        }
        scroll = 0;
      } else if (followsTail() && (key(data, 'pageUp') || key(data, 'pageDown'))) {
        scroll = Math.max(0, scroll + (key(data, 'pageUp') ? 8 : -8));
      } else if (focus === 'composer') {
        if (key(data, 'escape')) {
          say('');
        } else {
          editor.disableSubmit = clearing;
          editor.handleInput(data);
        }
      } else if (key(data, 'escape')) {
        if (focus === 'detail') {
          focus = 'reports';
          completedReport = null;
          if (!reports().some(report => report.id === selectedId)) selectedId = reports()[0]?.id ?? null;
        } else {
          view = 'conversation';
          focus = 'composer';
        }
        scroll = 0;
      } else if (view === 'reports' && focus === 'reports' && (key(data, 'up') || key(data, 'down'))) {
        const delta = key(data, 'down') ? 1 : -1;
        const list = reports();
        completedReport = null;
        selectedId = list[Math.max(0, Math.min(list.length - 1, selectedIndex() + delta))]?.id ?? null;
        scroll = 0;
      } else if (view === 'reports' && focus === 'reports' && key(data, 'enter')) {
        focus = 'detail';
        scroll = 0;
      } else if (key(data, 'pageDown') || key(data, 'down')) {
        scroll = Math.max(0, scroll + (key(data, 'pageDown') ? 8 : 1) * (isJob() ? -1 : 1));
      } else if (key(data, 'pageUp') || key(data, 'up')) {
        scroll = Math.max(0, scroll + (key(data, 'pageUp') ? 8 : 1) * (isJob() ? 1 : -1));
      }
      changed();
    },
    render(width, height) {
      width = Math.max(1, width);
      height = Math.max(1, height);
      rows = height;
      columns = width;
      contentBounds = { top: 0, bottom: 0 };
      if (question && (width < 60 || height < 18)) return [line('Enlarge to 60x18 to answer; Esc cancels.', width)];
      if (width < 35 || height < 14) return [line('Pi Companion · enlarge terminal (35x14)', width)];
      const inner = width - 4;
      const clock = now();
      const frame = spinner(clock);
      const header = renderHeader(inner, clock, frame);
      const footer = renderFooter(inner, height, header.length, clock, frame);
      const available = Math.max(1, height - header.length - footer.length);
      contentBounds = { top: header.length, bottom: height - footer.length };

      const { content, ranges = [] } = renderContent(inner, available, clock, frame);
      const maximum = Math.max(0, content.length - available);
      if (!question) scroll = Math.min(scroll, maximum);
      const displayScroll = Math.min(scroll, maximum);
      const listMode = showsReportList();
      if (listMode) {
        const [start, end] = ranges[selectedIndex()] ?? [0, 0];
        if (start < listTop) listTop = start;
        if (end > listTop + available) listTop = end - available;
        listTop = Math.max(0, Math.min(listTop, maximum));
      }
      let offset = displayScroll;
      if (listMode) offset = listTop;
      else if (followsTail()) offset = maximum - displayScroll;

      const framed = value => `  ${line(value, inner)}`;
      return [...header.map(framed), ...viewport({ content, offset, available, inner }), ...footer.map(framed)];
    },
  };
  animate();
  return controller;
}

export function startDashboard(snapshot, handlers = {}, options = {}) {
  const tui = new TuiAltScreen(options.terminal ?? new ProcessTerminal(), false, undefined, { mouse: true, wheelScrollLines: 3 });
  const controller = createDashboard(snapshot, handlers, { tui, onChange: () => tui.requestRender() });
  const component = {
    render: width => controller.render(width, tui.terminal.rows),
    handleInput: data => controller.input(data),
    handleMouse: event => controller.handleMouse(event),
    invalidate: () => controller.invalidate(),
    get focused() { return controller.focused; },
    set focused(value) { controller.focused = value; },
  };
  tui.addChild(component);
  tui.setFocus(component);

  // Paint with the user's Pi theme from the first frame and follow later theme switches or edits.
  const theme = options.theme ? followPiTheme(options.theme.cwd, next => {
    palette = next;
    controller.invalidate();
    tui.requestRender();
  }) : null;
  palette = theme?.palette ?? builtInPalette;

  // The dashboard owns paging and composer boundaries, not the outer viewport.
  const keybindings = getKeybindings();
  const previousBindings = keybindings.getUserBindings();
  let typingBindings = {};
  try {
    const config = JSON.parse(readFileSync(join(options.agentDir ?? getAgentDir(), 'keybindings.json'), 'utf8'));
    typingBindings = Object.fromEntries(Object.entries(config).filter(([name, keys]) =>
      /^(tui\.editor\.|tui\.input\.|tui\.select\.)/.test(name)
      && (typeof keys === 'string' || (Array.isArray(keys) && keys.every(key => typeof key === 'string')))));
  } catch { /* Missing or invalid optional keybindings use Pi defaults. */ }
  keybindings.setUserBindings({
    ...previousBindings,
    ...typingBindings,
    'tui.altScreen.pageUp': [],
    'tui.altScreen.pageDown': [],
    'tui.altScreen.top': [],
    'tui.altScreen.bottom': [],
  });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    theme?.stop();
    palette = builtInPalette;
    controller.stop();
    try {
      tui.stop({ preserveScreen: true });
    } finally {
      keybindings.setUserBindings(previousBindings);
    }
  };
  try {
    tui.start();
  } catch (error) {
    stop();
    throw error;
  }
  return { ...controller, stop };
}
