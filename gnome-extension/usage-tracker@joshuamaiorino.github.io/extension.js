import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// Copied from public/ by install.sh, so the top bar and the compact strip pick meters the same way.
import {
  PROVIDER_CATALOG,
  compactChip,
  duration,
  formatPercent,
  meterColor,
  relative,
  splitWindows,
  timestamp,
} from './usage-view.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

// Reading /api/usage never triggers provider requests; the server keeps its own schedule.
const POLL_SECONDS = 15;
const HOVER_DELAY_MS = 250;
const MUTED_OPACITY = 165;

function label(text, styleClass = '', { muted = false, wrap = false, ...props } = {}) {
  const actor = new St.Label({ text: String(text), style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...props });
  if (muted) actor.opacity = MUTED_OPACITY;
  if (wrap) {
    actor.clutter_text.line_wrap = true;
    actor.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
  }
  return actor;
}

function box(styleClass = '', vertical = false, props = {}) {
  return new St.BoxLayout({
    style_class: styleClass,
    orientation: vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
    ...props,
  });
}

function meter(percent, width) {
  const track = new St.Widget({ style_class: 'usage-tracker-track', style: `width: ${width}px;`, y_align: Clutter.ActorAlign.CENTER });
  const filled = Math.round(width * Math.max(0, Math.min(100, percent)) / 100);
  track.add_child(new St.Widget({ style_class: `usage-tracker-fill usage-tracker-${meterColor(percent)}`, style: `width: ${filled}px;` }));
  return track;
}

function catalogEntry(provider) {
  return PROVIDER_CATALOG.find(item => item.id === provider.id) ?? { id: provider.id, name: provider.name ?? provider.id, icon: '•' };
}

function localTime(milliseconds) {
  return GLib.DateTime.new_from_unix_local(Math.floor(milliseconds / 1000)).format('%a %-l:%M %p');
}

const UsageIndicator = GObject.registerClass(
class UsageIndicator extends PanelMenu.Button {
  _init(extension) {
    super._init(0.5, 'Usage Tracker');
    this._settings = extension.getSettings();
    this._session = new Soup.Session({ timeout: 15 });
    this._cancellable = new Gio.Cancellable();
    this._usage = null;
    this._connected = false;
    this._polling = false;
    this._busy = false;
    this._message = '';
    this._hoverTimeout = 0;

    this._chips = box('usage-tracker-chips', false, { y_align: Clutter.ActorAlign.CENTER });
    this.add_child(this._chips);

    // Reactive but inert: a non-reactive item would be styled :insensitive and grey out the details.
    const detailsItem = new PopupMenu.PopupBaseMenuItem({ activate: false, hover: false, can_focus: false });
    this._menuDetails = box('', true, { x_expand: true });
    detailsItem.add_child(this._menuDetails);
    this.menu.addMenuItem(detailsItem);
    this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    this._refreshItem = this.menu.addAction('Refresh usage', () => this._refresh());
    this.menu.addAction('Open dashboard', () => this._open('/'));
    this.menu.addAction('Open compact bar', () => this._open('/compact'));
    this._menuOpenId = this.menu.connect('open-state-changed', (_menu, open) => {
      if (!open) return;
      this._hideHover();
      this._render();
    });

    // A non-reactive panel under the button, so hovering shows details without taking a grab.
    this._hover = new St.Bin({ style_class: 'popup-menu', visible: false, reactive: false });
    this._hoverContent = box('popup-menu-content usage-tracker-hover', true);
    this._hover.set_child(this._hoverContent);
    Main.uiGroup.add_child(this._hover);
    this._hoverId = this.connect('notify::hover', () => this._syncHover());

    this._settingsId = this._settings.connect('changed::server-url', () => {
      this._usage = null;
      this._connected = false;
      this._poll();
    });

    this._render();
    this._poll();
    this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
      this._poll();
      return GLib.SOURCE_CONTINUE;
    });
  }

  _serverUrl() {
    return this._settings.get_string('server-url').replace(/\/+$/, '');
  }

  async _request(method, path, token) {
    let message;
    try {
      message = Soup.Message.new(method, `${this._serverUrl()}${path}`);
    } catch {
      message = null;
    }
    if (!message) throw new Error(`Invalid server URL: ${this._serverUrl()}`);
    message.request_headers.append('Accept', 'application/json');
    if (method === 'POST') {
      message.request_headers.append('X-Usage-Token', token ?? '');
      message.set_request_body_from_bytes('application/json', new GLib.Bytes(new TextEncoder().encode('{}')));
    }
    let bytes;
    try {
      bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable);
    } catch (error) {
      if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) throw error;
      throw new Error(`Cannot reach Usage Tracker at ${this._serverUrl()}.`);
    }
    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes.toArray()));
    } catch {
      throw new Error('Usage Tracker returned an unreadable response.');
    }
    const status = message.get_status();
    if (status < 200 || status >= 300) {
      throw new Error(typeof payload?.error?.message === 'string' ? payload.error.message
        : typeof payload?.error === 'string' ? payload.error
          : status === 429 ? 'A refresh is already queued or is backing off.' : `Usage Tracker answered ${status}.`);
    }
    return payload;
  }

  async _poll() {
    if (this._polling || this._busy) return;
    this._polling = true;
    try {
      const usage = await this._request('GET', '/api/usage');
      if (!Array.isArray(usage?.providers)) throw new Error('Usage Tracker returned an unreadable usage response.');
      this._usage = usage;
      this._connected = true;
      this._message = '';
    } catch (error) {
      if (this._cancellable.is_cancelled()) return;
      this._connected = false;
      this._message = error.message;
    } finally {
      this._polling = false;
    }
    this._render();
  }

  async _refresh() {
    if (this._busy) return;
    this._busy = true;
    this._message = '';
    this._render();
    try {
      // The CSRF token rotates with each server start, so fetch it right before posting.
      const accounts = await this._request('GET', '/api/accounts');
      const result = await this._request('POST', '/api/usage/refresh', accounts.csrfToken);
      this._usage = result;
      this._connected = true;
      const next = timestamp(result.nextRefreshAt);
      if (result.refreshed === false || result.refreshed === 0 || (Array.isArray(result.refreshed) && !result.refreshed.length)) {
        this._message = `Keeping last readings${next && next > Date.now() ? ` · next ${duration(next - Date.now())}` : ''}`;
      }
    } catch (error) {
      if (this._cancellable.is_cancelled()) return;
      this._message = error.message;
    } finally {
      this._busy = false;
    }
    this._render();
  }

  _open(path) {
    try {
      Gio.AppInfo.launch_default_for_uri(`${this._serverUrl()}${path}`, global.create_app_launch_context(0, -1));
    } catch (error) {
      Main.notifyError('Usage Tracker', error.message);
    }
  }

  _render() {
    this._renderChips();
    this._refreshItem.label.text = this._busy ? 'Checking…' : 'Refresh usage';
    this._refreshItem.setSensitive(!this._busy);
    if (this.menu.isOpen) this._fillDetails(this._menuDetails);
    if (this._hover.visible) this._showHover();
  }

  _renderChips() {
    this._chips.destroy_all_children();
    const providers = this._usage?.providers ?? [];
    if (!providers.length) {
      this._chips.add_child(label(this._usage ? '▥' : '▥ —', 'usage-tracker-chip-value', { muted: !this._connected }));
      return;
    }
    for (const provider of providers) {
      const info = catalogEntry(provider);
      const chip = compactChip(info, null, provider);
      const item = box('usage-tracker-chip', false, { y_align: Clutter.ActorAlign.CENTER });
      item.add_child(label(info.icon, 'usage-tracker-chip-icon'));
      if (chip.percent !== null) item.add_child(meter(chip.percent, 26));
      const value = chip.displayPercent !== null ? `${chip.displayPercent}%`
        : chip.state === 'loading' ? '…' : chip.state === 'missing' ? 'Login' : '—';
      item.add_child(label(value, 'usage-tracker-chip-value'));
      if (chip.windowLabel) item.add_child(label(chip.windowLabel, 'usage-tracker-chip-window'));
      // chip.urgentModelCount skips limits the compact strip gives their own cell; the top bar shows none.
      if (splitWindows(provider.windows).scoped.some(window => window.usedPercent >= 90)) item.add_child(label('!', 'usage-tracker-chip-alert'));
      if (chip.state !== 'ok' || !this._connected) item.opacity = MUTED_OPACITY;
      this._chips.add_child(item);
    }
  }

  _fillDetails(container) {
    container.destroy_all_children();
    const details = box('usage-tracker-details', true, { x_expand: true });
    container.add_child(details);
    const now = Date.now();
    if (!this._usage) {
      details.add_child(label(this._connected ? 'Waiting for the first reading…' : (this._message || 'Connecting…'), 'usage-tracker-warning', { wrap: true }));
      if (!this._connected) details.add_child(label('Start the server: systemctl --user start usage-tracker', 'usage-tracker-small', { muted: true, wrap: true }));
      return;
    }
    if (!this._usage.providers.length) {
      details.add_child(label('No accounts enabled. Open the dashboard to choose local logins.', 'usage-tracker-small', { muted: true, wrap: true }));
    }
    for (const provider of this._usage.providers) details.add_child(this._providerSection(provider, now));
    details.add_child(label(this._footer(now), 'usage-tracker-footer', { muted: true, wrap: true }));
  }

  _providerSection(provider, now) {
    const info = catalogEntry(provider);
    const chip = compactChip(info, null, provider, now);
    const section = box('usage-tracker-provider', true);

    const header = box('usage-tracker-provider-header');
    header.add_child(label(info.icon, 'usage-tracker-provider-icon'));
    header.add_child(label(info.name, 'usage-tracker-provider-name'));
    if (provider.plan) header.add_child(label(provider.plan, 'usage-tracker-small', { muted: true }));
    const status = { stale: 'last good', missing: 'login needed', error: 'unavailable', loading: 'checking…' }[chip.state];
    if (status) {
      header.add_child(new St.Widget({ x_expand: true }));
      header.add_child(label(status, 'usage-tracker-warning'));
    }
    section.add_child(header);

    const { primary, scoped } = splitWindows(provider.windows);
    for (const window of primary) section.add_child(this._windowRow(window, now));
    if (scoped.length) {
      section.add_child(label(`Model limits · ${scoped.length}`, 'usage-tracker-subhead', { muted: true }));
      for (const window of scoped) section.add_child(this._windowRow(window, now));
    }

    const retry = timestamp(provider.nextRetryAt);
    const retryText = retry !== null && retry > now ? ` Next attempt in ${duration(retry - now)}.` : '';
    if (!primary.length && !scoped.length) {
      const text = chip.state === 'missing' ? `Not logged in on this PC. Run ${provider.loginCommand ?? 'the CLI login'}.`
        : chip.state === 'loading' ? 'Waiting for the first usage reading.'
          : provider.error?.message ?? 'Usage is unavailable.';
      section.add_child(label(`${text}${retryText}`, 'usage-tracker-warning', { wrap: true }));
    } else if (provider.error) {
      section.add_child(label(`${provider.error.message} Showing the last good reading.${retryText}`, 'usage-tracker-warning', { wrap: true }));
    }

    for (const extra of Array.isArray(provider.extras) ? provider.extras : []) {
      const row = box('usage-tracker-small');
      row.add_child(label(extra.label, 'usage-tracker-small', { muted: true, x_expand: true }));
      row.add_child(label(extra.value, 'usage-tracker-small'));
      section.add_child(row);
    }
    if (timestamp(provider.lastSuccessAt) !== null) {
      section.add_child(label(`Updated ${relative(provider.lastSuccessAt, now)}`, 'usage-tracker-small', { muted: true }));
    }
    return section;
  }

  _windowRow(window, now) {
    const row = box('usage-tracker-window', true);
    const top = box();
    top.add_child(label(window.label || window.id, '', { x_expand: true }));
    top.add_child(label(`${formatPercent(window.usedPercent)}%`, 'usage-tracker-window-percent'));
    row.add_child(top);
    row.add_child(meter(window.usedPercent, 300));
    const reset = timestamp(window.resetsAt);
    const text = reset === null ? 'Reset time unavailable'
      : reset > now ? `Resets in ${duration(reset - now)} · ${localTime(reset)}` : 'Reset time passed';
    row.add_child(label(text, 'usage-tracker-small', { muted: true }));
    return row;
  }

  _footer(now) {
    if (this._busy) return 'Checking…';
    if (this._message) return this._connected ? this._message : `${this._message} Showing last readings.`;
    const successes = this._usage.providers.map(provider => timestamp(provider.lastSuccessAt)).filter(time => time !== null);
    const parts = [successes.length ? `Updated ${relative(Math.max(...successes), now)}` : 'No reading yet'];
    const next = timestamp(this._usage.nextRefreshAt);
    if (next !== null && next > now) parts.push(`next check in ${duration(next - now)}`);
    return parts.join(' · ');
  }

  _syncHover() {
    if (this._hoverTimeout) {
      GLib.source_remove(this._hoverTimeout);
      this._hoverTimeout = 0;
    }
    if (!this.hover || this.menu.isOpen) {
      this._hideHover();
      return;
    }
    this._hoverTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOVER_DELAY_MS, () => {
      this._hoverTimeout = 0;
      if (this.hover && !this.menu.isOpen) this._showHover();
      return GLib.SOURCE_REMOVE;
    });
  }

  _showHover() {
    this._fillDetails(this._hoverContent);
    this._hover.show();
    Main.uiGroup.set_child_above_sibling(this._hover, null);
    const [x, y] = this.get_transformed_position();
    const [width, height] = this.get_transformed_size();
    const [, hoverWidth] = this._hover.get_preferred_width(-1);
    const monitor = Main.layoutManager.findMonitorForActor(this) ?? Main.layoutManager.primaryMonitor;
    const left = Math.max(monitor.x + 6, Math.min(x + width / 2 - hoverWidth / 2, monitor.x + monitor.width - hoverWidth - 6));
    this._hover.set_position(Math.round(left), Math.round(y + height + 4));
  }

  _hideHover() {
    this._hover.hide();
  }

  _onDestroy() {
    this._cancellable.cancel();
    this._session.abort();
    if (this._timer) GLib.source_remove(this._timer);
    if (this._hoverTimeout) GLib.source_remove(this._hoverTimeout);
    this._timer = 0;
    this._hoverTimeout = 0;
    this._settings.disconnect(this._settingsId);
    this.menu.disconnect(this._menuOpenId);
    this.disconnect(this._hoverId);
    this._hover.destroy();
    super._onDestroy();
  }
});

export default class UsageTrackerExtension extends Extension {
  enable() {
    this._indicator = new UsageIndicator(this);
    Main.panel.addToStatusArea(this.uuid, this._indicator);
  }

  disable() {
    this._indicator?.destroy();
    this._indicator = null;
  }
}
