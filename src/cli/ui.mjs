import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import {
  Editor, Markdown, ProcessTerminal, SelectList, TuiAltScreen, getKeybindings, matchesKey,
  stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi,
} from '@earendil-works/pi-tui';

// The caller supplies already-loaded arrays; render never reads history or starts work.
const clean = value => stripTerminalSequences(String(value ?? '')).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
const line = (value, width) => truncateToWidth(value, Math.max(1, width));
const cell = (value, width) => {
  const text = line(value, width);
  return text + ' '.repeat(Math.max(0, width - visibleWidth(text)));
};
const wrapped = (value, width) => String(value ?? '').split('\n').flatMap(part =>
  wrapTextWithAnsi(clean(part), Math.max(1, width)));
const style = (open, close) => text => `\x1b[${open}m${text}\x1b[${close}m`;
const bold = style(1, 22);
const dim = style('38;2;157;168;186', 39);
const accent = style('38;2;139;233;253', 39);
const warning = style('38;2;241;250;140', 39);
const assistantColor = style('38;2;189;147;249', 39);
const effortColor = style('38;2;255;184;108', 39);
const highlight = style('38;2;255;121;198', 39);
const positive = style('38;2;80;250;123', 39);
const negative = style('38;2;255;85;85', 39);
const compactNumber = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const tokenCount = value => compactNumber.format(value).toLowerCase();
const selectTheme = {
  selectedPrefix: highlight,
  selectedText: highlight,
  description: dim,
  scrollInfo: dim,
  noMatch: dim,
};
const markdownTheme = {
  heading: text => assistantColor(bold(text)),
  link: accent,
  linkUrl: dim,
  code: accent,
  codeBlock: text => text,
  codeBlockBorder: dim,
  quote: dim,
  quoteBorder: dim,
  hr: dim,
  listBullet: accent,
  bold,
  italic: style(3, 23),
  strikethrough: style(9, 29),
  underline: style(4, 24),
};
const row = (left, right, width) => cell(left, Math.max(1, width - visibleWidth(right) - 2)) + '  ' + right;
const key = (data, name) => matchesKey(data, name);
const runDistance = (at, now) => {
  const minutes = (Date.parse(at) - now) / 60000;
  if (minutes <= 0) return 'due now';
  if (minutes < 1) return 'in less than a minute';
  const unit = minutes < 60 ? 'minute' : minutes < 1440 ? 'hour' : 'day';
  const amount = Math.round(minutes / (unit === 'minute' ? 1 : unit === 'hour' ? 60 : 1440));
  return `in ${unit === 'hour' ? 'about ' : ''}${amount} ${unit}${amount === 1 ? '' : 's'}`;
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
  const pad = value => String(value).padStart(2, '0');
  const zone = new Intl.DateTimeFormat('en', { timeZoneName: 'short' }).formatToParts(date)
    .find(part => part.type === 'timeZoneName').value;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${zone}`;
};
const timestamp = (value, now, elapsed = false) => {
  const at = typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? `${relativeTime(at, now, elapsed)} · ${fixedTime(at)}`
    : '';
};

export function createDashboard(initial, handlers = {}, options = {}) {
  let snapshot = initial;
  let callbacks = handlers;
  let selectedId = snapshot.reports?.[0]?.id ?? null;
  let completedReport = null;
  let focus = 'composer';
  let view = 'conversation';
  let scroll = 0;
  let rows = 24;
  let columns = 80;
  let contentBounds = { top: 0, bottom: 0 };
  let hasFocus = true;
  let question = null;
  let notice = '';
  let hiddenMessages = new Set(snapshot.presentation?.hiddenMessageIds ?? []);
  const messageKey = message => message.id ?? JSON.stringify(message);
  const visibleMessageIds = () => (snapshot.messages ?? [])
    .filter(message => !hiddenMessages.has(messageKey(message)) && clean(message.content).trim())
    .map(messageKey);
  let pending = Promise.resolve();
  let clearing = false;
  let stopped = false;
  const onChange = options.onChange ?? (() => {});
  const reports = () => (snapshot.reports ?? []).slice(0, 25);
  const allReports = () => snapshot.reports ?? [];
  const liveJobs = () => snapshot.connection === 'connected' ? (snapshot.runs ?? []).filter(run =>
    run.state === 'running' && run.kind === 'background'
    && typeof run.scheduleId === 'string' && run.scheduleId.trim()) : [];
  const views = () => ['conversation', 'reports', 'schedules', ...liveJobs().map(run => `job:${run.id}`)];
  const isJob = () => view.startsWith('job:');
  const followsTail = () => view === 'conversation' || isJob();
  const selectedIndex = () => Math.max(0, reports().findIndex(report => report.id === selectedId));
  const changed = () => { if (!stopped) onChange(); };
  const connected = () => snapshot.connection === 'connected' && typeof callbacks.send === 'function';

  const editor = new Editor(options.tui ?? {
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
        notice = 'Unknown command. Use /clear or /reset.';
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
          notice = 'Main context reset.';
        }, error => { notice = `Reset failed: ${clean(error?.message ?? error)}`; })
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
          notice = 'Visible chat cleared; context and history kept.';
        }, error => {
          if (!editor.getExpandedText()) editor.setText(submitted);
          notice = `Clear failed: ${clean(error?.message ?? error)}`;
        })
        .finally(() => {
          clearing = false;
          changed();
        });
      return;
    }
    if (!submitted.trim() || clearing) return;
    if (!connected()) {
      notice = 'Offline — send unavailable until the main conversation connects';
      changed();
      return;
    }
    notice = 'Sending…';
    pending = Promise.resolve().then(() => callbacks.send(submitted)).then(() => {
      if (editor.getExpandedText() === submitted) editor.setText('');
      editor.addToHistory(submitted);
      view = 'conversation';
      focus = 'composer';
      scroll = 0;
      notice = '';
    }, error => {
      notice = `Send failed: ${clean(error?.message ?? error)}`;
    }).finally(() => {
      changed();
    });
  };

  const documents = new Map();
  const markdown = (value, width) => {
    const text = String(value ?? '').split('\n').map(clean).join('\n');
    if (!documents.has(text)) {
      if (documents.size >= 128) documents.delete(documents.keys().next().value);
      documents.set(text, new Markdown(text, 0, 0, markdownTheme));
    }
    return documents.get(text).render(width);
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
      changed();
    },
    invalidate() {
      editor.invalidate();
      for (const document of documents.values()) document.invalidate();
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
        notice = 'Requesting cancellation…';
        pending = Promise.resolve().then(() => {
          if (typeof callbacks.kill !== 'function') throw Error('Kill unavailable');
          return callbacks.kill(runId);
        }).then(accepted => {
          notice = accepted ? 'Cancellation accepted.' : 'No owned running job.';
        }, error => { notice = `Kill failed: ${clean(error?.message ?? error)}`; })
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
          notice = '';
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
      const { main = {} } = snapshot.config ?? {};
      const counts = snapshot.counts ?? {};
      const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
      const state = clean(snapshot.connection ?? 'offline');
      const live = snapshot.connection === 'connected';
      const activeRuns = liveJobs();
      const running = activeRuns.length;
      const activity = [live && snapshot.busy ? 'working' : state, running ? `${running} running` : ''].filter(Boolean).join(' · ');
      const diagnostics = (snapshot.runs ?? []).filter(run => run.state === 'invalid');
      const cost = Number.isFinite(snapshot.usage?.usd) ? `$${snapshot.usage.usd.toFixed(2)} est.` : '';
      const model = snapshot.main?.model ?? main.model;
      const effort = snapshot.main?.effort ?? main.effort;
      const binding = [
        effort ? effortColor(bold(clean(effort))) : '',
        model ? assistantColor(clean(model)) : '',
      ].filter(Boolean).join(dim(' · '));
      const tabLabels = [
        ['conversation', 'Chat'],
        ['reports', `Reports (${allReports().length})`],
        ['schedules', `Schedules (${total})`],
        ...activeRuns.map(run => {
          const title = run.title
            || snapshot.schedules?.find(schedule => schedule.id === run.scheduleId)?.title
            || 'Background job';
          return [`job:${run.id}`, line(clean(title), 24)];
        }),
      ];
      const tabRows = [''];
      let activeRow = 0;
      for (const [name, label] of tabLabels) {
        const text = line(label, inner);
        let index = tabRows.length - 1;
        if (tabRows[index] && visibleWidth(tabRows[index]) + visibleWidth(text) + 3 > inner) {
          tabRows.push('');
          index++;
        }
        if (name === view) activeRow = index;
        tabRows[index] += (tabRows[index] ? '   ' : '') + (name === view ? highlight(bold(text)) : dim(text));
      }
      const tabStart = Math.max(0, Math.min(activeRow - 1, tabRows.length - 3));
      const context = snapshot.context;
      const percentage = Number.isFinite(context?.percent) ? ` (${Math.round(context.percent)}%)` : '';
      const contextLine = context ? [
        Number.isFinite(context.tokens)
          ? `Context ~${tokenCount(context.tokens)}${Number.isFinite(context.contextWindow) ? `/${tokenCount(context.contextWindow)}` : ''}${percentage}` : '',
        context.auto == null ? '' : `auto ${context.auto ? 'on' : 'off'}`,
        Number.isFinite(context.compactions) ? `compacted ${context.compactions}` : '',
      ].filter(Boolean).join(' · ') : '';
      const header = [
        row(highlight(bold('Pi Companion')), (live && (snapshot.busy || running) ? positive : dim)(activity), inner),
        '',
        row(binding, cost ? accent(cost) : '', inner),
        ...(contextLine ? wrapTextWithAnsi(accent(contextLine), inner) : []),
        ...tabRows.slice(tabStart, tabStart + 3),
        dim('─'.repeat(inner)),
      ];
      if (diagnostics.length) header.push(warning(`${diagnostics.length} invalid schedules · see Schedules`));
      editor.focused = hasFocus && focus === 'composer';
      const hint = focus === 'composer' ? 'Enter send · Left/Right views when empty · Ctrl+J newline · Ctrl+C quit'
        : focus === 'reports' ? '↑↓ select · Enter read · Left/Right views · Esc chat'
          : 'PgUp/Dn scroll · Left/Right views · Esc back';
      const activityNotice = context?.compacting && connected() ? 'Compacting…'
        : live && snapshot.busy ? 'Thinking…' : connected() ? hint : 'Offline — send unavailable';
      const statusColor = snapshot.error || /^(Send|Clear|Reset|Kill) failed:/.test(notice) ? negative
        : notice ? warning : snapshot.busy || context?.compacting ? highlight : dim;
      const clock = (options.now ?? Date.now)();
      const schedules = snapshot.schedules ?? [];
      const upcoming = schedules.filter(schedule => schedule.enabled && schedule.nextRun?.at)
        .toSorted((a, b) => Date.parse(a.nextRun.at) - Date.parse(b.nextRun.at))[0];
      const nextNotice = snapshot.connection !== 'connected' ? dim('waiting for connection')
        : upcoming ? `${assistantColor(clean(upcoming.title))}${dim(' · ')}${accent(runDistance(upcoming.nextRun.at, clock))}`
          : schedules.some(schedule => schedule.enabled) ? dim('no next run scheduled')
            : schedules.length ? negative('none · all schedules paused') : dim('no schedules');
      let questionLines = [];
      if (question) {
        const choices = question.selection.render(inner);
        const text = [
          ...wrapped(question.question, inner).map(highlight),
          ...wrapped(question.selection.getSelectedItem()?.label, inner).map(accent),
        ];
        const capacity = Math.max(1, Math.min(Math.floor((height - header.length) / 2),
          height - header.length - choices.length - 6));
        question.scroll = Math.min(question.scroll, Math.max(0, text.length - capacity));
        questionLines = [dim('─'.repeat(inner)), ...text.slice(question.scroll, question.scroll + capacity),
          ...choices, dim('↑↓ choose · Enter answer · Esc cancel · PgUp/Dn read')];
      }
      const footer = question ? questionLines : [
        ...(isJob() ? [] : editor.render(inner)),
        ...(isJob() ? [statusColor(clean(notice || snapshot.error || 'k kill job · PgUp/Dn scroll · Left/Right views · Esc chat'))]
          : [statusColor(clean(notice || snapshot.error || activityNotice))]),
      ];
      footer.push(dim('Next: ') + nextNotice);
      const available = Math.max(1, height - header.length - footer.length);
      contentBounds = { top: header.length, bottom: height - footer.length };
      let content = [];
      const mainFocus = question?.previous.focus ?? focus;
      if (view === 'schedules') {
        content = [
          highlight(bold('Schedules')),
          dim(clean(`${counts.daily ?? 0} daily · ${counts.weekly ?? 0} weekly · ${counts.monthly ?? 0} monthly · ${counts.compatibility ?? 0} migrated`)),
          '',
        ];
        for (const diagnostic of diagnostics) {
          content.push(...wrapped(diagnostic.title, inner).map(warning), '');
        }
        const hasActiveRun = schedule => activeRuns.some(run => run.scheduleId === schedule.id);
        const orderedSchedules = schedules.toSorted((left, right) =>
          Number(hasActiveRun(right)) - Number(hasActiveRun(left)));
        const jobLines = run => [
          ...wrapTextWithAnsi([
            run.harness ? assistantColor(clean(run.harness)) : '',
            run.model ? assistantColor(clean(run.model)) : '',
            run.effort ? effortColor(clean(run.effort)) : '',
          ].filter(Boolean).join(dim(' · ')), inner),
        ];
        for (const schedule of orderedSchedules) {
          const jobs = activeRuns.filter(run => run.scheduleId === schedule.id);
          const legacy = schedule.legacy?.legacy;
          const zone = schedule.timezone ? new Intl.DateTimeFormat('en-US', {
            timeZone: schedule.timezone, timeZoneName: 'shortGeneric',
          }).formatToParts(clock).find(part => part.type === 'timeZoneName').value : '';
          const when = legacy ? `${legacy.type} ${legacy.schedule}` : [
            schedule.cadence,
            schedule.weekday == null ? '' : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][schedule.weekday],
            schedule.day == null ? '' : `day ${schedule.day}`,
            schedule.window ? `${schedule.window.start}–${schedule.window.end} ${zone} · every ${schedule.window.everyMinutes}m`
              : `${Array.isArray(schedule.at) ? schedule.at.join(', ') : schedule.at} ${zone}`,
          ].filter(Boolean).join(' · ');
          let timing;
          let timingColor;
          if (jobs.length) {
            timing = 'Running now';
            timingColor = positive;
          } else if (!schedule.enabled) {
            timing = 'Paused';
            timingColor = negative;
          } else if (schedule.nextRun?.at) {
            timing = `Next run ${runDistance(schedule.nextRun.at, clock)}`;
            timingColor = accent;
          } else if (schedule.nextRun?.state === 'running') {
            timing = live ? 'Running now' : 'Activity unavailable (saved state)';
            timingColor = live ? positive : dim;
          } else {
            const next = schedule.nextRun;
            const lifecycle = {
              completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', expired: 'Expired',
              paused: 'Paused', pending: 'Awaiting scheduler', blocked: 'Invalid schedule',
            };
            timing = next?.reason ? next.reason.replaceAll('_', ' ') : lifecycle[next?.state] ?? '';
            timingColor = ['blocked', 'failed', 'cancelled'].includes(next?.state) ? negative : dim;
          }
          content.push(
            ...wrapped(`${clean(schedule.title)}${jobs.length ? ' · Running Now' : ''}`, inner).map(value => assistantColor(bold(value))),
            ...wrapped(when, inner).map(accent),
            ...(jobs.length ? [] : wrapped(timing, inner).map(timingColor)),
          );
          for (const run of jobs) content.push(...jobLines(run));
          content.push('');
        }
        const scheduleIds = new Set(schedules.map(schedule => schedule.id));
        for (const run of activeRuns.filter(item => !scheduleIds.has(item.scheduleId))) {
          content.push(
            warning(`Orphan scheduled job · ${run.scheduleId}`),
            positive(bold(clean(run.title ?? run.id))),
            ...jobLines(run),
            '',
          );
        }
        if (!snapshot.schedules?.length) content.push('No schedules yet. Add a file to schedules/daily, weekly or monthly.');
      } else if (isJob()) {
        const blocks = snapshot.jobActivity?.[view.slice(4)] ?? [];
        for (const block of blocks) {
          if (block.kind === 'assistant' && clean(block.text).trim()) {
            content.push(...wrapped(clean(block.agentName || 'Companion'), inner).map(value => assistantColor(bold(value))), ...markdown(block.text, inner), '');
          } else if (block.kind === 'tool') {
            const color = block.state === 'failed' ? negative : dim;
            content.push(...wrapped(`${block.agentName ? `${clean(block.agentName)} · ` : ''}${block.name} · ${block.state}`, inner).map(color));
            if (block.input) content.push(...wrapped(block.input, inner).map(accent));
            if (block.output) content.push(...wrapped(block.output, inner));
            content.push('');
          }
        }
        if (!content.length) content = [dim('No parent activity received yet.')];
      } else if (view === 'conversation') {
        for (const message of snapshot.messages ?? []) {
          if (hiddenMessages.has(messageKey(message)) || !clean(message.content).trim()) continue;
          const role = message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Companion' : clean(message.role);
          const color = message.role === 'user' ? accent : assistantColor;
          if (message.role === 'notice') content.push(...wrapped(message.content, inner).map(dim), '');
          else content.push(color(bold(role)), ...markdown(message.content, inner), '');
        }
        if (!content.length) {
          content = [
            '', bold('What would you like to work on?'), '',
            ...wrapped('Message your agent below. Reports from scheduled checks appear in Reports.', inner),
            '', dim('Left/Right switches views. /clear clears visible chat.'),
          ];
        }
      } else if (mainFocus === 'reports') {
        const capacity = Math.max(1, Math.floor((available - 2) / 2));
        const listStart = Math.max(0, selectedIndex() - capacity + 1);
        content = [dim('↑↓ select · Enter read'), ''];
        for (const report of reports().slice(listStart, listStart + capacity)) {
          const title = clean(report.title);
          content.push(
            report.id === selectedId ? highlight(bold(title)) : assistantColor(title),
            dim(timestamp(report.at, clock)),
          );
        }
        if (!reports().length) content.push('No reports yet.');
      } else {
        const current = completedReport ?? reports()[selectedIndex()];
        content = current ? [
          assistantColor(bold(clean(current.title))),
          ...(timestamp(current.at, clock) ? wrapped(timestamp(current.at, clock), inner).map(accent) : []),
          ...(current.outcome ? [dim(clean(current.outcome))] : []),
          ...(current.origin ? [
            ...wrapped([current.readState, current.provider ? `provider ${current.provider}` : '', current.origin].filter(Boolean).join(' · '), inner),
            ...wrapped(`Source: ${current.path}${current.truncated ? ' (preview truncated)' : ''}`, inner),
          ] : []),
          '', ...markdown(current.body, inner),
        ] : ['No report selected.'];
      }
      const maximum = Math.max(0, content.length - available);
      if (!question) scroll = Math.min(scroll, maximum);
      const displayScroll = Math.min(scroll, maximum);
      const offset = followsTail() ? maximum - displayScroll : mainFocus === 'reports' ? 0 : displayScroll;
      const visible = content.slice(offset, offset + available);
      return [...header, ...visible, ...Array(Math.max(0, available - visible.length)).fill(''), ...footer]
        .map(item => '  ' + line(item, inner));
    },
  };
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
