const catalog = [
  { id: 'claude', name: 'Claude', icon: '✳', loginCommand: 'claude auth login' },
  { id: 'chatgpt', name: 'ChatGPT', icon: '◎', loginCommand: 'codex login' },
  { id: 'grok', name: 'Grok', icon: '𝕏', loginCommand: 'grok login' },
];
const $ = id => document.getElementById(id);
const state = { accounts: null, settings: null, csrfToken: '', usage: null, meta: null, connected: false, busy: false };
let toastTimer;
let lastCardsSignature = '';
let polling = false;
let lastDiscovery = 0;

// All provider strings pass through escaping before entering an HTML template.
function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function timestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : null;
}

function duration(milliseconds) {
  const minutes = Math.max(1, Math.ceil(milliseconds / 60000));
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes}m`;
}

function relative(value) {
  const time = timestamp(value);
  if (time === null) return 'never';
  const elapsed = Math.max(0, Date.now() - time);
  if (elapsed < 60000) return 'just now';
  return `${duration(Math.floor(elapsed / 60000) * 60000)} ago`;
}

function absolute(value) {
  const time = timestamp(value);
  return time === null ? '' : new Date(time).toLocaleString();
}

function notify(message) {
  $('toast').textContent = message;
  $('toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 6000);
}

function showError(id, message = '') {
  $(id).textContent = message;
  $(id).hidden = !message;
}

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
    throw new Error('Cannot reach your workspace. Keep the server running on this PC and check your connection.');
  }
  let payload;
  try { payload = await response.json(); } catch {
    throw new Error('The workspace returned an unreadable response. Try again after restarting the server.');
  }
  if (!response.ok) {
    const message = typeof payload?.error?.message === 'string' ? payload.error.message :
      typeof payload?.error === 'string' ? payload.error :
      response.status === 403 ? 'Your workspace session changed. Reload the page and try again.' :
      response.status === 429 ? 'A refresh is already queued or is backing off. Wait for the next scheduled check.' :
      'The workspace could not complete this request. Please try again.';
    throw new Error(message);
  }
  return payload;
}

function applyAccounts(payload) {
  if (!Array.isArray(payload?.accounts) || !payload.settings) throw new Error('Account discovery returned an unreadable response.');
  state.accounts = catalog.map(provider => ({ ...provider, ...payload.accounts.find(account => account.id === provider.id), id: provider.id, name: provider.name }));
  state.settings = payload.settings;
  if (typeof payload.csrfToken === 'string') state.csrfToken = payload.csrfToken;
  lastDiscovery = Date.now();
}

function enabledProviders() {
  if (!state.settings) return catalog;
  return catalog.filter(provider => state.settings.enabled?.[provider.id]);
}

function usableWindows(provider) {
  return Array.isArray(provider.windows) ? provider.windows.filter(window =>
    typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent) && window.usedPercent >= 0) : [];
}

function planLabel(value) {
  const labels = { free: 'Free', plus: 'Plus', pro: 'Pro', prolite: 'Pro Lite', pro_lite: 'Pro Lite', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu', go: 'Go' };
  const key = String(value).toLowerCase();
  return Object.hasOwn(labels, key) ? labels[key] : value;
}

function meter(window, name) {
  const value = window.usedPercent;
  const color = value >= 90 ? 'red' : value >= 70 ? 'amber' : 'green';
  const display = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
  const label = window.label || window.id || 'Usage allowance';
  const reset = timestamp(window.resetsAt);
  return `<div class="meter"><div class="meter-title"><span>${escape(label)}</span><strong>${escape(display)}<span>%</span></strong></div><div class="track" role="meter" aria-label="${escape(name)}: ${escape(label)} used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, value)}" aria-valuetext="${escape(display)} percent used"><div class="fill ${color}" style="width:${Math.min(100, value)}%"></div></div><small${reset === null ? '' : ` data-reset="${reset}" title="${escape(absolute(reset))}"`}>${reset === null ? 'Reset time unavailable' : reset > Date.now() ? `Resets in ${duration(reset - Date.now())}` : 'Reset time passed; awaiting update'}</small></div>`;
}

function errorTitle(code = '') {
  if (/auth|expired|login|refresh_unsupported/i.test(code)) return 'Reconnect your account';
  if (/credential|missing|not_found|keychain|unsupported_store/i.test(code)) return 'A local login is needed';
  if (/rate|429|backoff/i.test(code)) return 'Rate limited · backing off';
  if (/format|schema|parse|unrecognized/i.test(code)) return 'Usage format changed';
  return 'Usage is unavailable';
}

function renderCard(info, previousOpen) {
  const account = state.accounts?.find(account => account.id === info.id);
  const snapshot = state.usage?.providers?.find(provider => provider.id === info.id);
  const provider = snapshot || { status: 'loading', windows: [] };
  const windows = usableWindows(provider);
  const hasHistory = timestamp(provider.lastSuccessAt) !== null;
  const stale = provider.status === 'stale' || (provider.status === 'error' && hasHistory && windows.length > 0);
  const failed = !!provider.error || provider.status === 'error' || stale || (provider.status === 'ok' && !windows.length);
  const missing = account && !account.found;
  const loading = !failed && provider.status === 'loading' && !windows.length;
  const code = provider.error?.code || account?.status || '';
  let badge = stale ? 'Last good' : failed ? 'Unavailable' : loading ? 'Checking' : 'Connected';
  if (failed && /rate|429|backoff/i.test(code)) badge = 'Backing off';
  else if (failed && /auth|expired|login|refresh_unsupported/i.test(code)) badge = 'Login needed';
  if (missing && !snapshot) badge = 'Login needed';
  let plan = planLabel(provider.plan || account?.plan) || 'Plan unavailable';
  if (info.id === 'chatgpt' && !/codex/i.test(plan)) plan += ' · Codex';
  let content = '';
  if (failed && windows.length) {
    content += `<div class="error-message">${escape(provider.error?.message || 'The latest check failed.')}<small>Showing the last successful reading.${timestamp(provider.nextRetryAt) === null ? '' : ` <span data-retry="${timestamp(provider.nextRetryAt)}"></span>`}</small></div>`;
  }
  if (windows.length) {
    const scoped = windows.filter(window => window.scope && !['all', 'general', 'shared', 'codex', 'subscription'].includes(String(window.scope).toLowerCase()));
    let primary = windows.filter(window => !scoped.includes(window));
    // A model-only response still has useful data; do not hide its only meter.
    if (!primary.length) { primary = scoped.splice(0, scoped.length); }
    content += primary.map(window => meter(window, info.name)).join('');
    const extras = Array.isArray(provider.extras) ? provider.extras.filter(extra => extra && typeof extra.label === 'string' && ['string', 'number', 'boolean'].includes(typeof extra.value)) : [];
    if (scoped.length || extras.length || info.id === 'chatgpt') {
      const detailsId = `${info.id}-details`;
      content += `<details class="details" id="${detailsId}"${previousOpen.has(detailsId) ? ' open' : ''}><summary>${scoped.length ? 'Model limits & account details' : 'About this allowance'}</summary>`;
      if (info.id === 'chatgpt') content += '<p>These are Codex coding limits. They do not represent all ChatGPT conversations.</p>';
      content += scoped.map(window => meter(window, info.name)).join('');
      if (extras.length) content += `<dl class="extras">${extras.map(extra => `<div class="extra-row"><dt>${escape(extra.label)}</dt><dd>${escape(extra.value)}</dd></div>`).join('')}</dl>`;
      content += '</details>';
    }
  } else if (loading && !missing) {
    content += '<div class="loading-state"><span class="loading-indicator" aria-hidden="true"></span><span>Waiting for the first usage reading…</span><small>No allowance estimate yet.</small></div>';
  } else {
    const loginNeeded = missing || /auth|expired|login|credential|keychain|refresh_unsupported/i.test(code);
    const title = missing ? 'Not logged in on this PC' : failed ? errorTitle(code) : 'No usage reading available';
    const message = provider.error?.message || account?.message || 'No recognized usage allowance was returned. The provider format may have changed.';
    content += `<div class="empty-state"><h4>${escape(title)}</h4><p>${escape(message)}</p>${loginNeeded ? `<code>${escape(info.loginCommand)}</code>` : '<p>No usage percentage is available.</p>'}${timestamp(provider.nextRetryAt) === null ? '' : `<p data-retry="${timestamp(provider.nextRetryAt)}"></p>`}</div>`;
  }
  const updated = hasHistory ? `<span title="${escape(absolute(provider.lastSuccessAt))}">${stale ? 'Last success' : 'Updated'} <time data-relative="${timestamp(provider.lastSuccessAt)}">${relative(provider.lastSuccessAt)}</time></span>` : '<span>No successful reading yet</span>';
  const footerNote = stale ? 'Stale data' : info.id === 'chatgpt' ? 'Codex usage' : 'CLI login';
  return `<article class="card ${info.id}${stale ? ' stale' : ''}" aria-labelledby="${info.id}-title"><div class="card-main"><div class="provider-heading"><span class="provider-icon" aria-hidden="true">${info.icon}</span><div><h3 id="${info.id}-title">${info.name}</h3><div class="plan">${escape(plan)}</div></div><span class="status${failed || missing ? ' warning' : loading ? ' loading' : ''}">${badge}</span></div>${content}</div><div class="card-footer">${updated}<span>${footerNote}</span></div></article>`;
}

function accountRows(target, readOnly = false, selections) {
  const accounts = state.accounts || catalog;
  $(target).innerHTML = accounts.map(account => {
    const checked = selections ? selections[account.id] : state.settings?.enabled?.[account.id];
    const description = account.found ? `${planLabel(account.plan) || 'CLI login'} · found${account.email ? ` · ${account.email}` : ''}` : account.message || 'No supported CLI login found on this PC';
    return `<label class="account-row${account.found ? '' : ' missing'}"><span><strong>${escape(account.name)}</strong><small>${escape(description)}</small>${account.found ? '' : `<small>Run <code>${escape(catalog.find(provider => provider.id === account.id).loginCommand)}</code>, then rescan.</small>`}</span>${readOnly ? `<span class="status ${account.found ? '' : 'neutral'}">${account.found ? 'Found' : 'Not found'}</span>` : `<input type="checkbox" data-provider="${account.id}" aria-label="Enable ${escape(account.name)}"${checked ? ' checked' : ''}${!account.found && !checked ? ' disabled' : ''}>`}</label>`;
  }).join('');
}

function render() {
  const enabled = enabledProviders();
  const setup = !!state.accounts && enabled.length === 0;
  $('setup').hidden = !setup;
  $('dashboard').hidden = setup;
  $('refresh').disabled = state.busy || !state.connected || !enabled.length;
  $('settings').disabled = !state.accounts;
  $('cards').setAttribute('aria-busy', String(!state.usage));
  $('account-count').textContent = state.accounts ? `${enabled.length} account${enabled.length === 1 ? '' : 's'}` : 'Connecting';
  if (setup) {
    accountRows('setup-accounts', true);
    const found = state.accounts.filter(account => account.found).length;
    $('setup-description').textContent = found ? 'Your local logins are ready. Enable found accounts, or choose individual accounts in Settings.' : 'Log in with a CLI on this PC, then rescan. Your existing subscription powers the dashboard.';
    $('enable-all').disabled = !found || state.busy;
    $('discovery-note').textContent = `${found} supported login${found === 1 ? '' : 's'} found · no API keys needed`;
  }
  const signature = JSON.stringify([enabled, state.accounts, state.usage?.providers]);
  if (signature !== lastCardsSignature) {
    const previousOpen = new Set([...$('cards').querySelectorAll('details[open]')].map(details => details.id));
    const focusedDetails = document.activeElement?.closest('#cards details')?.id;
    $('cards').innerHTML = enabled.map(provider => renderCard(provider, previousOpen)).join('');
    if (focusedDetails) document.getElementById(focusedDetails)?.querySelector('summary')?.focus({ preventScroll: true });
    lastCardsSignature = signature;
  }
  const minutes = Math.round((state.settings?.refreshIntervalMs || 180000) / 60000);
  $('local-description').textContent = `Your local CLI logins provide the connection. Usage checks run every ${minutes} minutes, with a pause when providers rate limit.`;
  $('workspace-label').textContent = state.meta?.bindMode === 'lan' ? 'Local Wi-Fi workspace' : 'Local workspace';
  updateTimes();
}

function updateTimes() {
  document.querySelectorAll('[data-reset]').forEach(element => {
    const remaining = Number(element.dataset.reset) - Date.now();
    element.textContent = remaining > 0 ? `Resets in ${duration(remaining)}` : 'Reset time passed; awaiting update';
  });
  document.querySelectorAll('[data-relative]').forEach(element => { element.textContent = relative(Number(element.dataset.relative)); });
  document.querySelectorAll('[data-retry]').forEach(element => {
    const remaining = Number(element.dataset.retry) - Date.now();
    element.textContent = remaining > 0 ? `Next attempt in ${duration(remaining)}.` : 'Waiting for the next scheduled attempt.';
  });
  if (!state.connected) {
    $('refresh-note').textContent = state.usage ? 'Workspace disconnected · keeping last readings' : 'Connecting to your workspace…';
    return;
  }
  const successes = (state.usage?.providers || []).map(provider => timestamp(provider.lastSuccessAt)).filter(time => time !== null);
  if (successes.length) $('refresh-note').textContent = `Latest success · ${relative(Math.max(...successes))}`;
  else $('refresh-note').textContent = enabledProviders().length ? 'No successful usage reading yet' : 'Enable an account to check usage';
  $('refresh-note').title = timestamp(state.usage?.nextRefreshAt) === null ? '' : `Next scheduled check: ${absolute(state.usage.nextRefreshAt)}`;
}

function renderLan() {
  const meta = state.meta;
  const desired = $('lan').checked;
  const active = meta?.bindMode === 'lan';
  if (!meta) $('lan-note').textContent = 'The current listening address is unavailable.';
  else if (desired !== active) $('lan-note').textContent = `Restart required after saving to ${desired ? 'allow Wi-Fi access' : 'return to localhost only'}. Currently ${active ? 'accessible on your local network' : 'localhost only'}.`;
  else $('lan-note').textContent = active ? 'Wi-Fi access is active. Share this address only with people you trust on your network.' : `Localhost only · ${meta.localUrl || 'this PC'}`;
  let lanUrl = null;
  try {
    const candidate = new URL(meta?.lanUrl);
    if (candidate.protocol === 'http:' || candidate.protocol === 'https:') lanUrl = candidate.href;
  } catch { /* Missing LAN address is a normal localhost state. */ }
  $('lan-share').hidden = !active || !lanUrl;
  if (active && lanUrl) {
    $('lan-url').href = lanUrl;
    $('lan-url').textContent = lanUrl;
    if (!$('lan-qr').getAttribute('src')) $('lan-qr').src = '/api/qr.svg';
  }
}

function settingsSelections() {
  return Object.fromEntries([...$('settings-accounts').querySelectorAll('input')].map(input => [input.dataset.provider, input.checked]));
}

async function rescan(inSettings = false) {
  const button = $(inSettings ? 'settings-rescan' : 'rescan');
  button.disabled = true;
  const errorTarget = inSettings ? 'settings-error' : 'setup-error';
  showError(errorTarget);
  try {
    const selections = inSettings ? settingsSelections() : null;
    applyAccounts(await api('/api/accounts'));
    if (inSettings) accountRows('settings-accounts', false, selections);
    render();
    notify('Local CLI logins rescanned.');
  } catch (error) { showError(errorTarget, error.message); }
  finally { button.disabled = false; }
}

async function saveAccounts(body) {
  // The server may return the new account snapshot or an acknowledgement.
  const result = await api('/api/accounts', body);
  if (Array.isArray(result?.accounts) && result.settings) applyAccounts(result);
  else applyAccounts(await api('/api/accounts'));
  const results = await Promise.allSettled([api('/api/usage'), api('/api/meta')]);
  if (results[0].status === 'fulfilled') state.usage = results[0].value;
  if (results[1].status === 'fulfilled') state.meta = results[1].value;
  render();
}

$('settings').addEventListener('click', () => {
  accountRows('settings-accounts');
  const savedInterval = state.settings?.refreshIntervalMs || 180000;
  $('interval').querySelectorAll('[data-custom]').forEach(option => option.remove());
  if (![...$('interval').options].some(option => option.value === String(savedInterval))) {
    const option = document.createElement('option');
    option.value = String(savedInterval);
    option.textContent = `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(savedInterval / 60000)} minutes (saved)`;
    option.dataset.custom = 'true';
    $('interval').append(option);
  }
  $('interval').value = String(savedInterval);
  $('lan').checked = !!state.settings?.lanEnabled;
  showError('settings-error');
  renderLan();
  $('settings-dialog').showModal();
});
$('close-settings').addEventListener('click', () => $('settings-dialog').close());
$('lan').addEventListener('change', renderLan);
$('settings-rescan').addEventListener('click', () => rescan(true));
$('rescan').addEventListener('click', () => rescan(false));
$('settings-enable-all').addEventListener('click', () => {
  $('settings-accounts').querySelectorAll('input').forEach(input => {
    if (state.accounts.find(account => account.id === input.dataset.provider)?.found) input.checked = true;
  });
});
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const save = $('save');
  if (save.disabled) return;
  save.disabled = true;
  save.textContent = 'Saving…';
  showError('settings-error');
  try {
    await saveAccounts({ enabled: settingsSelections(), refreshIntervalMs: Number($('interval').value), lanEnabled: $('lan').checked });
    $('settings-dialog').close();
    notify(state.meta?.restartRequired ? 'Settings saved. Restart the server to apply the Wi-Fi access change.' : 'Workspace settings saved.');
  } catch (error) { showError('settings-error', error.message); }
  finally { save.disabled = false; save.textContent = 'Save settings'; }
});
$('enable-all').addEventListener('click', async () => {
  state.busy = true;
  render();
  showError('setup-error');
  try {
    await saveAccounts({ enableAll: true });
    notify('Found accounts enabled. Usage checks are scheduled on this PC.');
  } catch (error) { showError('setup-error', error.message); }
  finally { state.busy = false; render(); }
});
$('refresh').addEventListener('click', async () => {
  if (state.busy) return;
  state.busy = true;
  $('refresh').disabled = true;
  $('refresh').innerHTML = '<span aria-hidden="true">↻</span> &nbsp; Checking…';
  const previous = new Map((state.usage?.providers || []).map(provider => [provider.id, provider.lastSuccessAt]));
  try {
    const result = await api('/api/usage/refresh', {});
    state.usage = result;
    state.connected = true;
    showError('connection-error');
    const advanced = (result.providers || []).filter(provider => provider.lastSuccessAt && provider.lastSuccessAt !== previous.get(provider.id));
    if (advanced.length) notify(`${advanced.map(provider => catalog.find(info => info.id === provider.id)?.name || provider.name).join(', ')} usage updated.`);
    else if (result.refreshed === false || result.refreshed === 0 || (Array.isArray(result.refreshed) && !result.refreshed.length)) {
      const next = timestamp(result.nextRefreshAt);
      notify(`Keeping the last readings. Refreshes respect the two-minute minimum and provider backoff.${next && next > Date.now() ? ` Next check in ${duration(next - Date.now())}.` : ''}`);
    }
    else notify('Check completed without a new successful reading. See each account for its status.');
  } catch (error) { notify(error.message); }
  finally {
    state.busy = false;
    $('refresh').innerHTML = '<span aria-hidden="true">↻</span> &nbsp; Refresh usage';
    render();
  }
});

function applyTheme(light) {
  document.body.classList.toggle('light', light);
  $('theme').setAttribute('aria-label', `Switch to ${light ? 'dark' : 'light'} theme`);
  document.querySelector('meta[name="theme-color"]').setAttribute('content', light ? '#f4f5f0' : '#101313');
}
try { applyTheme(localStorage.getItem('usage-tracker-theme') === 'light'); } catch { /* Theme persistence is optional. */ }
$('theme').addEventListener('click', () => {
  const light = !document.body.classList.contains('light');
  applyTheme(light);
  try { localStorage.setItem('usage-tracker-theme', light ? 'light' : 'dark'); } catch { /* Private browsing may disallow storage. */ }
});

async function poll() {
  if (polling || state.busy) return;
  polling = true;
  try {
    const rediscover = !state.accounts || Date.now() - lastDiscovery >= 60000;
    const results = await Promise.allSettled([api('/api/usage'), ...(rediscover ? [api('/api/accounts'), api('/api/meta')] : [])]);
    if (results[0].status === 'rejected') throw results[0].reason;
    if (!Array.isArray(results[0].value?.providers)) throw new Error('The workspace returned an unreadable usage response.');
    state.usage = results[0].value;
    state.connected = true;
    if (rediscover) {
      if (results[1].status === 'fulfilled') applyAccounts(results[1].value);
      else if (!state.accounts) throw results[1].reason;
      if (results[2].status === 'fulfilled') state.meta = results[2].value;
      if ($('settings-dialog').open) renderLan();
    }
    showError('connection-error');
  } catch (error) {
    state.connected = false;
    showError('connection-error', error.message);
  } finally {
    polling = false;
    render();
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { updateTimes(); poll(); }
});
window.addEventListener('online', poll);
render();
poll();
setInterval(() => { if (!document.hidden) poll(); }, 10000);
setInterval(updateTimes, 15000);
