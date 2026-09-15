export const PROVIDER_CATALOG = [
  // Claude's model limits (e.g. Fable) always get a compact cell; other scoped limits only when hot.
  { id: 'claude', name: 'Claude', icon: '✳', loginCommand: 'claude auth login', showModelLimits: true },
  { id: 'chatgpt', name: 'ChatGPT', icon: '◎', loginCommand: 'codex login' },
  { id: 'grok', name: 'Grok', icon: '𝕏', loginCommand: 'grok login' },
];

const GENERIC_SCOPES = new Set(['all', 'general', 'shared', 'codex', 'subscription']);
const FIVE_HOURS = 5 * 60 * 60;
const WEEK = 7 * 24 * 60 * 60;
const MAX_COMPACT_CELLS = 3;
const HOT_SCOPED_PERCENT = 70;

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

export function timestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : null;
}

export function duration(milliseconds) {
  const minutes = Math.max(1, Math.ceil(milliseconds / 60000));
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes}m`;
}

export function relative(value, now = Date.now()) {
  const time = timestamp(value);
  if (time === null) return 'never';
  const elapsed = Math.max(0, now - time);
  if (elapsed < 60000) return 'just now';
  return `${duration(Math.floor(elapsed / 60000) * 60000)} ago`;
}

export function absolute(value) {
  const time = timestamp(value);
  return time === null ? '' : new Date(time).toLocaleString();
}

export function meterColor(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'neutral';
  return value >= 90 ? 'red' : value >= 70 ? 'amber' : 'green';
}

export function formatPercent(value) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
}

export function usableWindows(providerOrWindows) {
  const windows = Array.isArray(providerOrWindows) ? providerOrWindows : providerOrWindows?.windows;
  return Array.isArray(windows) ? windows.filter(window =>
    typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent) && window.usedPercent >= 0) : [];
}

export function splitWindows(windows) {
  const usable = usableWindows(windows);
  const scoped = usable.filter(window => window.scope && !GENERIC_SCOPES.has(String(window.scope).toLowerCase()));
  const primary = usable.filter(window => !scoped.includes(window));
  if (!primary.length) return { primary: scoped, scoped: [] };
  return { primary, scoped };
}

export function windowShortLabel(window) {
  if (!window) return '';
  const seconds = window.durationSeconds;
  if (Number.isFinite(seconds) && seconds > 0) {
    if (seconds >= 86400 && seconds % 86400 === 0) return `${seconds / 86400}d`;
    if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}h`;
    if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}m`;
  }
  if (window.id === 'session' || window.id === 'weekly') return window.id;
  if (window.id === 'monthly') return 'mo';
  const label = String(window.label || window.id || '').trim();
  return label ? label.replace(/\s+/g, ' ').slice(0, 12) : '';
}

function windowUrgency(window) {
  if (window.id === 'session' || window.durationSeconds === 5 * 60 * 60) return 0;
  if (window.id === 'weekly' || window.durationSeconds === 7 * 24 * 60 * 60) return 1;
  return 2;
}

export function hottestWindow(windows) {
  const { primary } = splitWindows(windows);
  if (!primary.length) return null;
  return primary.reduce((worst, window) => {
    if (window.usedPercent > worst.usedPercent) return window;
    if (window.usedPercent < worst.usedPercent) return worst;
    return windowUrgency(window) < windowUrgency(worst) ? window : worst;
  });
}

function resetText(window, now) {
  const reset = timestamp(window.resetsAt);
  if (reset === null) return 'reset time unavailable';
  if (reset <= now) return 'reset time passed';
  const clock = new Date(reset).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  return `resets in ${duration(reset - now)} (${clock})`;
}

export function resetCountdown(value, now = Date.now()) {
  const reset = timestamp(value);
  if (reset === null) return null;
  if (reset <= now) return { long: 'now', short: 'now' };
  const long = duration(reset - now);
  return { long, short: long.split(' ')[0] };
}

function cellLabels(window) {
  const session = window.durationSeconds === FIVE_HOURS;
  if (window.scope) {
    const scope = String(window.scope).replace(/\s+/g, ' ').trim();
    return { label: session ? `${scope} 5h` : scope, shortLabel: `${scope.split(' ')[0].slice(0, 8)}${session ? ' 5h' : ''}` };
  }
  const label = session ? 'Session' : window.durationSeconds === WEEK ? 'Weekly' : window.id === 'monthly' ? 'Monthly' : windowShortLabel(window);
  return { label, shortLabel: windowShortLabel(window) };
}

const byDuration = (a, b) => (a.durationSeconds ?? Number.MAX_SAFE_INTEGER) - (b.durationSeconds ?? Number.MAX_SAFE_INTEGER);

// Account-wide windows first (shortest first), then the hottest scoped limits that still fit.
export function compactCells(windows, { showModelLimits = false } = {}) {
  const { primary, scoped } = splitWindows(windows);
  const shown = [...primary].sort(byDuration);
  const extra = scoped.filter(window => showModelLimits || window.usedPercent >= HOT_SCOPED_PERCENT)
    .sort((a, b) => b.usedPercent - a.usedPercent || byDuration(a, b))
    .slice(0, Math.max(0, MAX_COMPACT_CELLS - shown.length))
    .sort((a, b) => byDuration(a, b) || String(a.scope).localeCompare(String(b.scope)));
  return [...shown, ...extra];
}

export function compactChip(info, account, snapshot, now = Date.now()) {
  const provider = snapshot || { status: 'loading', windows: [] };
  const windows = usableWindows(provider);
  const hasHistory = timestamp(provider.lastSuccessAt) !== null;
  const stale = provider.status === 'stale' || (provider.status === 'error' && hasHistory && windows.length > 0);
  const failed = !!provider.error || provider.status === 'error' || stale || (provider.status === 'ok' && !windows.length);
  const missing = Boolean(account && account.found === false);
  const loading = !failed && provider.status === 'loading' && !windows.length;
  const { primary, scoped } = splitWindows(windows);
  const window = hottestWindow(windows);
  const percent = window ? window.usedPercent : null;
  const code = provider.error?.code || account?.status || '';
  let state = 'ok';
  if (missing && !snapshot) state = 'missing';
  else if (loading) state = 'loading';
  else if (windows.length && stale) state = 'stale';
  else if (windows.length) state = 'ok';
  else if (missing || /auth|expired|login|credential|keychain|refresh_unsupported/i.test(code)) state = 'missing';
  else state = 'error';

  const lines = [info.name];
  for (const item of primary) {
    lines.push(`${item.label || item.id}: ${formatPercent(item.usedPercent)}% · ${resetText(item, now)}`);
  }
  if (scoped.length) {
    const hot = scoped.filter(item => item.usedPercent >= 90).length;
    lines.push(`${scoped.length} model limit${scoped.length === 1 ? '' : 's'}${hot ? `, ${hot} at 90% or more` : ''}`);
  }
  if (!windows.length) {
    if (state === 'missing') lines.push(account?.message || 'Not logged in on this PC');
    else if (state === 'loading') lines.push('Waiting for the first usage reading');
    else lines.push(provider.error?.message || 'Usage is unavailable');
  }
  if (stale) lines.push('Showing the last successful reading');
  if (hasHistory) lines.push(`Updated ${relative(provider.lastSuccessAt, now)}`);

  const cells = compactCells(windows, { showModelLimits: info.showModelLimits }).map(item => ({
    id: item.id,
    ...cellLabels(item),
    fullLabel: item.label || item.id,
    percent: item.usedPercent,
    displayPercent: formatPercent(item.usedPercent),
    color: meterColor(item.usedPercent),
    reset: resetCountdown(item.resetsAt, now),
    title: `${info.name} · ${item.label || item.id}\n${formatPercent(item.usedPercent)}% used · ${resetText(item, now)}${stale ? '\nShowing the last successful reading' : ''}`,
  }));

  return {
    id: info.id,
    name: info.name,
    icon: info.icon,
    state,
    percent,
    color: percent === null ? 'neutral' : meterColor(percent),
    windowLabel: windowShortLabel(window),
    displayPercent: percent === null ? null : formatPercent(percent),
    // Only hot limits that did not fit in a cell still need the "!" badge.
    urgentModelCount: scoped.filter(item => item.usedPercent >= 90 && !cells.some(cell => cell.id === item.id)).length,
    cells,
    title: lines.join('\n'),
  };
}
