// Illustrative fixtures only. No credentials, provider requests, or persistence.
const providers = [
  { id: 'claude', name: 'Claude', plan: 'Max 5x', icon: '✳', windows: [['Session · 5 hours', 42, '2h 14m'], ['Weekly · 7 days', 76, '3d 8h']] },
  { id: 'chatgpt', name: 'ChatGPT', plan: 'Plus · Codex', icon: '◎', windows: [['Session · 5 hours', 18, '4h 32m'], ['Weekly · 7 days', 34, '5d 12h']] },
  { id: 'grok', name: 'Grok', plan: 'SuperGrok', icon: '𝕏', windows: [['Shared pool · 7 days', 92, '1d 6h']] }
];
const enabled = new Set(providers.map(p => p.id));
let view = 'dashboard';
let toastTimer;
const $ = id => document.getElementById(id);
function notify(message) {
  $('toast').textContent = message;
  $('toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 3500);
}
function meter([name, value, reset], provider) {
  const color = value >= 90 ? 'red' : value >= 70 ? 'amber' : 'green';
  return `<div class="meter"><div class="meter-title"><span>${name}</span><strong>${value}<span>%</span></strong></div><div class="track" role="meter" aria-label="${provider}: ${name} used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${value}"><div class="fill ${color}" style="width:${value}%"></div></div><small>Resets in ${reset}</small></div>`;
}
function render() {
  $('setup').hidden = view !== 'setup';
  $('dashboard').hidden = view === 'setup';
  $('refresh').disabled = view === 'setup';
  document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === view)));
  $('account-count').textContent = `${enabled.size} account${enabled.size === 1 ? '' : 's'}`;
  $('cards').innerHTML = providers.filter(p => enabled.has(p.id)).map(p => {
    const errors = view === 'errors';
    const stale = errors && p.id === 'claude';
    let content = p.windows.map(w => meter(w, p.name)).join('');
    let status = 'Connected';
    let footer = '<span>Updated just now</span><span>CLI login</span>';
    if (stale) {
      status = 'Backing off';
      content = '<div class="error-message">Rate limited · retry in 8m.<br>Showing the last successful reading.</div>' + content;
      footer = '<span>Last success · 12m ago</span><span>Stale data</span>';
    } else if (errors && p.id === 'chatgpt') {
      status = 'Login needed';
      content = '<div class="empty-state"><h4>Reconnect your account</h4><p>Your session could not be renewed. Log in with the CLI on this PC.</p><code>codex login</code></div>';
      footer = '<span>No successful reading</span><span>Authentication failed</span>';
    } else if (errors && p.id === 'grok') {
      status = 'Unavailable';
      content = '<div class="empty-state"><h4>Usage format changed</h4><p>We couldn’t read this response. The provider parser needs an update.</p><p>No usage percentage is available.</p></div>';
      footer = '<span>No successful reading</span><span>Format error</span>';
    } else if (p.id === 'grok') {
      content += '<details class="details"><summary>About this allowance</summary><p>This preview illustrates a shared pool. Product breakdowns appear only when the provider supplies them.</p></details>';
    } else if (p.id === 'claude') {
      content += '<details class="details"><summary>Model-specific limits</summary><p>Illustrative additional weekly window</p>' + meter(['Sonnet · 7 days', 38, '3d 8h'], p.name) + '</details>';
    }
    return `<article class="card ${p.id} ${stale ? 'stale' : ''}"><div class="card-main"><div class="provider-heading"><span class="provider-icon" aria-hidden="true">${p.icon}</span><div><h3>${p.name}</h3><div class="plan">${p.plan}</div></div><span class="status ${errors ? 'warning' : ''}">${status}</span></div>${content}</div><div class="card-footer">${footer}</div></article>`;
  }).join('');
  if (!enabled.size) $('cards').innerHTML = '<div class="setup-panel"><h2>No accounts enabled</h2><p>Open Settings to choose accounts for your dashboard.</p></div>';
}
function accountRows(target, setup = false) {
  $(target).innerHTML = providers.map(p => `<label class="account-row"><span><strong>${p.name}</strong><small>${setup && p.id === 'grok' ? 'No login found · run grok login on this PC' : 'CLI login found · sample account'}</small></span><input type="checkbox" data-provider="${p.id}" aria-label="Enable ${p.name}" ${setup && p.id === 'grok' ? 'disabled' : enabled.has(p.id) ? 'checked' : ''}></label>`).join('');
}
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
  view = button.dataset.view;
  if (view === 'setup') accountRows('setup-accounts', true);
  render();
}));
$('enable-all').addEventListener('click', () => {
  enabled.clear();
  // This action intentionally selects every found account, as its label promises.
  providers.filter(p => p.id !== 'grok').forEach(p => enabled.add(p.id));
  view = 'dashboard'; render(); notify('Two sample accounts enabled. No credentials were accessed.');
});
$('setup-accounts').addEventListener('change', event => {
  if (!event.target.dataset.provider) return;
  // Individual selection is immediately reflected when switching to Dashboard.
  event.target.checked ? enabled.add(event.target.dataset.provider) : enabled.delete(event.target.dataset.provider);
});
$('settings').addEventListener('click', () => { accountRows('settings-accounts'); $('settings-dialog').showModal(); });
$('save').addEventListener('click', () => {
  enabled.clear();
  document.querySelectorAll('#settings-accounts input:checked').forEach(input => enabled.add(input.dataset.provider));
  render(); notify(`Preview settings saved · ${$('interval').value}-minute interval. No server settings changed.`);
});
$('lan').addEventListener('change', () => {
  $('lan-note').textContent = $('lan').checked ? 'Preview only · a LAN address would appear here. The PC must stay on; phone installation depends on browser support.' : 'Localhost only · 127.0.0.1:3140';
});
$('theme').addEventListener('click', () => {
  const light = document.body.classList.toggle('light');
  $('theme').setAttribute('aria-label', `Switch to ${light ? 'dark' : 'light'} theme`);
});
$('refresh').addEventListener('click', () => {
  $('refresh-note').textContent = 'Sample preview refreshed · just now';
  notify(view === 'errors' ? 'Error scenario preserved. A live refresh would respect provider backoff.' : 'Sample snapshot refreshed. No provider requests were made.');
});
render();
