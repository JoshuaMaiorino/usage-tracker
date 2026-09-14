import {
  PROVIDER_CATALOG,
  compactChip,
  duration,
  escapeHtml,
  relative,
  timestamp,
} from './usage-view.js';

const $ = id => document.getElementById(id);
const state = { accounts: null, settings: null, csrfToken: '', usage: null, connected: false, busy: false };
let polling = false;
let lastDiscovery = 0;
let lastChipsSignature = '';
let actionMessage = '';

async function api(path, body) {
  let response;
  try {
    response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined ? { Accept: 'application/json' } : {
        Accept: 'application/json', 'Content-Type': 'application/json', 'X-Usage-Token': state.csrfToken,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(body === undefined ? 15000 : 65000),
    });
  } catch {
    throw new Error('Cannot reach your workspace. Keep the server running on this PC.');
  }
  let payload;
  try { payload = await response.json(); } catch {
    throw new Error('The workspace returned an unreadable response.');
  }
  if (!response.ok) {
    const message = typeof payload?.error?.message === 'string' ? payload.error.message :
      typeof payload?.error === 'string' ? payload.error :
      response.status === 403 ? 'Reload compact view and try again.' :
      response.status === 429 ? 'A refresh is already queued or is backing off.' :
      'The workspace could not complete this request.';
    throw new Error(message);
  }
  return payload;
}

function enabledProviders() {
  if (!state.settings) return PROVIDER_CATALOG;
  return PROVIDER_CATALOG.filter(provider => state.settings.enabled?.[provider.id]);
}

function applyAccounts(payload) {
  if (!Array.isArray(payload?.accounts) || !payload.settings) throw new Error('Account discovery returned an unreadable response.');
  state.accounts = PROVIDER_CATALOG.map(provider => ({
    ...provider,
    ...payload.accounts.find(account => account.id === provider.id),
    id: provider.id,
    name: provider.name,
  }));
  state.settings = payload.settings;
  if (typeof payload.csrfToken === 'string') state.csrfToken = payload.csrfToken;
  lastDiscovery = Date.now();
}

function valueLabel(chip) {
  if (chip.displayPercent !== null) return `${escapeHtml(chip.displayPercent)}<span>%</span>`;
  if (chip.state === 'loading') return '…';
  if (chip.state === 'missing') return 'Login';
  return '—';
}

function renderChip(info) {
  const account = state.accounts?.find(item => item.id === info.id);
  const snapshot = state.usage?.providers?.find(provider => provider.id === info.id);
  const chip = compactChip(info, account, snapshot);
  const meter = chip.percent === null ? '' :
    `<span class="compact-track" role="meter" aria-label="${escapeHtml(info.name)} used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, chip.percent)}" aria-valuetext="${escapeHtml(chip.displayPercent)} percent used"><span class="fill ${chip.color}" style="width:${Math.min(100, chip.percent)}%"></span></span>`;
  const alert = chip.urgentModelCount
    ? `<span class="compact-alert" title="${chip.urgentModelCount} model limit${chip.urgentModelCount === 1 ? '' : 's'} at 90% or more">!</span>`
    : '';
  const window = chip.windowLabel ? `<span class="compact-window">${escapeHtml(chip.windowLabel)}</span>` : '';
  return `<a class="compact-chip ${info.id} ${chip.state}${chip.percent === null ? '' : ` tone-${chip.color}`}" href="/#${info.id}-title" title="${escapeHtml(chip.title)}"><span class="compact-icon" aria-hidden="true">${info.icon}</span><span class="compact-copy"><span class="compact-name">${escapeHtml(info.name)}</span><span class="compact-meter">${meter}<strong>${valueLabel(chip)}</strong></span></span>${window}${alert}</a>`;
}

function render() {
  const enabled = enabledProviders();
  $('refresh').disabled = state.busy || !state.connected || !enabled.length;
  if (!state.accounts) {
    $('chips').textContent = 'Connecting…';
    lastChipsSignature = '';
    updateNote();
    return;
  }
  if (!enabled.length) {
    $('chips').innerHTML = '<p class="compact-empty">No accounts enabled. <a href="/">Open the dashboard</a> to choose local logins.</p>';
    lastChipsSignature = 'setup';
    updateNote();
    return;
  }
  const signature = JSON.stringify([enabled.map(provider => provider.id), state.accounts, state.usage?.providers]);
  if (signature !== lastChipsSignature) {
    $('chips').innerHTML = enabled.map(provider => renderChip(provider)).join('');
    lastChipsSignature = signature;
  }
  updateNote();
}

function updateNote() {
  const note = $('compact-note');
  if (actionMessage) note.textContent = actionMessage;
  else if (state.busy) note.textContent = 'Checking…';
  else if (!state.connected) note.textContent = state.usage ? 'Disconnected · last readings' : 'Connecting…';
  else {
    const successes = (state.usage?.providers || []).map(provider => timestamp(provider.lastSuccessAt)).filter(time => time !== null);
    if (successes.length) note.textContent = `Updated ${relative(Math.max(...successes))}`;
    else note.textContent = enabledProviders().length ? 'No reading yet' : 'Enable an account';
  }
  note.title = timestamp(state.usage?.nextRefreshAt) === null ? '' : `Next scheduled check: ${new Date(state.usage.nextRefreshAt).toLocaleString()}`;
  $('refresh').title = note.textContent;
}

function applyTheme(light) {
  document.body.classList.toggle('light', light);
  $('theme').setAttribute('aria-label', `Switch to ${light ? 'dark' : 'light'} theme`);
  document.querySelector('meta[name="theme-color"]').setAttribute('content', light ? '#f4f5f0' : '#101313');
}

async function poll() {
  if (polling || state.busy) return;
  polling = true;
  try {
    const rediscover = !state.accounts || Date.now() - lastDiscovery >= 60000;
    const results = await Promise.allSettled([api('/api/usage'), ...(rediscover ? [api('/api/accounts')] : [])]);
    if (results[0].status === 'rejected') throw results[0].reason;
    if (!Array.isArray(results[0].value?.providers)) throw new Error('The workspace returned an unreadable usage response.');
    state.usage = results[0].value;
    state.connected = true;
    actionMessage = '';
    if (rediscover) {
      if (results[1].status === 'fulfilled') applyAccounts(results[1].value);
      else if (!state.accounts) throw results[1].reason;
    }
  } catch (error) {
    state.connected = false;
    if (!state.accounts) $('chips').textContent = error.message;
    else actionMessage = error.message;
  } finally {
    polling = false;
    render();
  }
}

try { applyTheme(localStorage.getItem('usage-tracker-theme') === 'light'); } catch { /* Theme persistence is optional. */ }
$('theme').addEventListener('click', () => {
  const light = !document.body.classList.contains('light');
  applyTheme(light);
  try { localStorage.setItem('usage-tracker-theme', light ? 'light' : 'dark'); } catch { /* Private browsing may disallow storage. */ }
});

$('refresh').addEventListener('click', async () => {
  if (state.busy) return;
  state.busy = true;
  actionMessage = '';
  render();
  try {
    const result = await api('/api/usage/refresh', {});
    state.usage = result;
    state.connected = true;
    const next = timestamp(result.nextRefreshAt);
    if (result.refreshed === false || result.refreshed === 0 || (Array.isArray(result.refreshed) && !result.refreshed.length)) {
      actionMessage = `Keeping last readings${next && next > Date.now() ? ` · next ${duration(next - Date.now())}` : ''}`;
    }
  } catch (error) {
    actionMessage = error.message;
  } finally {
    state.busy = false;
    render();
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) poll();
});
window.addEventListener('online', poll);
render();
poll();
setInterval(() => { if (!document.hidden) poll(); }, 10000);
setInterval(() => { if (!document.hidden && state.usage) updateNote(); }, 15000);
