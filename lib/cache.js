export const MIN_REFRESH_INTERVAL_MS = 120_000;
const DEFAULT_INTERVAL_MS = 180_000;
const MAX_BACKOFF_MS = 3_600_000;
const SLOW_RETRY_MS = 300_000;
const SLOW_RETRY_CODES = new Set([
  'missing', 'unreadable', 'malformed', 'unsupported', 'auth', 'format',
  'credentials_write', 'refresh_unsupported', 'forbidden',
]);
const DIAGNOSTIC_EVENTS = new Set(['refresh_started', 'refresh_succeeded', 'refresh_failed']);
const ORDER = ['claude', 'chatgpt', 'grok'];
const NAMES = { claude: 'Claude', chatgpt: 'ChatGPT', grok: 'Grok' };
const LOGIN_COMMANDS = { claude: 'claude auth login', chatgpt: 'codex login', grok: 'grok login' };
const ERROR_MESSAGES = {
  missing: 'Not logged in on this PC.',
  unreadable: 'The CLI login file could not be read.',
  malformed: 'The CLI login file is not valid JSON. Sign in again with the CLI.',
  unsupported: 'This credential store or login type is not supported.',
  auth: 'Your login has expired. Sign in again with the CLI.',
  rate_limited: 'Rate limited — backing off.',
  network: 'Could not reach the provider. Will retry automatically.',
  timeout: 'The provider took too long to respond. Will retry automatically.',
  format: 'Usage format changed — parser needs updating.',
  credentials_busy: 'The CLI login changed or is busy. Will retry automatically.',
  credentials_write: 'The renewed CLI login could not be saved safely. Sign in again with the CLI.',
  refresh_unsupported: 'This login cannot be renewed safely here. Sign in again with the CLI.',
  forbidden: 'The provider did not allow access to subscription usage.',
  provider: 'The provider could not return usage. Will retry automatically.',
};

const iso = (value) => {
  if (value === null || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const interval = (value) => Number.isFinite(value) && value > 0 ? Math.max(MIN_REFRESH_INTERVAL_MS, value) : DEFAULT_INTERVAL_MS;

function safeError(error) {
  const code = error?.status === 429 || error?.statusCode === 429
    ? 'rate_limited'
    : Object.hasOwn(ERROR_MESSAGES, error?.code) ? error.code : 'network';
  return { code, message: ERROR_MESSAGES[code] };
}

function cleanSnapshot(value, id) {
  if (!value || !Array.isArray(value.windows) || !value.windows.length) {
    throw Object.assign(new Error(ERROR_MESSAGES.format), { code: 'format' });
  }
  const windows = value.windows.filter((window) => window && typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent) && window.usedPercent >= 0).map((window) => ({
    id: String(window.id), label: String(window.label), usedPercent: window.usedPercent,
    resetsAt: typeof window.resetsAt === 'string' ? window.resetsAt : null,
    ...(Number.isFinite(window.durationSeconds) && window.durationSeconds > 0 ? { durationSeconds: window.durationSeconds } : {}),
    ...(typeof window.scope === 'string' ? { scope: window.scope } : {}),
  }));
  if (!windows.length) throw Object.assign(new Error(ERROR_MESSAGES.format), { code: 'format' });
  return {
    id, name: NAMES[id], plan: typeof value.plan === 'string' ? value.plan : null,
    windows,
    extras: Array.isArray(value.extras) ? value.extras.filter((extra) => extra && typeof extra.label === 'string' && ['number', 'string'].includes(typeof extra.value)).map(({ label, value: extraValue }) => ({ label, value: extraValue })) : [],
  };
}

/** One server-owned scheduler. Reading snapshot() never initiates network work. */
export class UsageCache {
  constructor({ providers = {}, intervalMs = DEFAULT_INTERVAL_MS, now = Date.now, random = Math.random, onDiagnostic = null } = {}) {
    this.providers = new Map();
    if (Array.isArray(providers)) {
      for (const provider of providers) if (ORDER.includes(provider.id)) this.providers.set(provider.id, provider.fetch.bind(provider));
    } else {
      for (const [id, provider] of Object.entries(providers)) {
        if (ORDER.includes(id)) this.providers.set(id, typeof provider === 'function' ? provider : provider.fetch.bind(provider));
      }
    }
    this.intervalMs = interval(intervalMs);
    this.now = now;
    this.random = random;
    this.onDiagnostic = typeof onDiagnostic === 'function' ? onDiagnostic : null;
    this.enabled = new Set();
    this.states = new Map(ORDER.map((id) => [id, {
      good: null, error: null, lastAttemptAt: null, lastSuccessAt: null,
      blockedUntil: 0, rateLimitFailures: 0, transientFailures: 0, inFlight: null,
    }]));
    this.running = false;
    this.timer = null;
  }

  setEnabled(ids) {
    this.enabled = new Set(Array.isArray(ids) ? ids.filter((id) => ORDER.includes(id) && this.providers.has(id)) : []);
    if (this.running) return this.refresh();
    return Promise.resolve({ refreshed: false, suppressed: false, nextRefreshAt: this.nextRefreshAt });
  }

  setInterval(milliseconds) {
    this.intervalMs = interval(milliseconds);
    this.schedule();
  }

  start() {
    if (this.running) return Promise.resolve({ refreshed: false, nextRefreshAt: this.nextRefreshAt });
    this.running = true;
    return this.refresh();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
  }

  dueAt(state, force = false) {
    // Never sample a later clock tick while deciding which first requests are due.
    if (state.lastAttemptAt === null) return 0;
    return Math.max(state.lastAttemptAt + (force ? MIN_REFRESH_INTERVAL_MS : this.intervalMs), state.blockedUntil);
  }

  nextAt(force = false) {
    const values = [...this.enabled].map((id) => this.dueAt(this.states.get(id), force));
    return values.length ? Math.max(this.now(), Math.min(...values)) : null;
  }

  get nextRefreshAt() {
    return iso(this.nextAt());
  }

  snapshot() {
    return ORDER.filter((id) => this.enabled.has(id)).map((id) => {
      const state = this.states.get(id);
      return {
        ...(state.good ? structuredClone(state.good) : { id, name: NAMES[id], plan: null, windows: [], extras: [] }),
        loginCommand: LOGIN_COMMANDS[id],
        status: state.error ? state.good ? 'stale' : 'error' : state.good ? 'ok' : 'loading',
        error: state.error ? { ...state.error } : null,
        refreshing: Boolean(state.inFlight),
        lastSuccessAt: iso(state.lastSuccessAt),
        lastAttemptAt: iso(state.lastAttemptAt),
        nextRetryAt: state.error ? iso(this.dueAt(state)) : null,
      };
    });
  }

  async refresh({ force = false } = {}) {
    let refreshed = false;
    const work = [];
    const current = this.now();
    for (const id of ORDER) {
      if (!this.enabled.has(id)) continue;
      const state = this.states.get(id);
      if (state.inFlight) {
        work.push(state.inFlight);
      } else if (current >= this.dueAt(state, force)) {
        refreshed = true;
        work.push(this.fetchProvider(id, state));
      }
    }
    await Promise.all(work);
    this.schedule();
    return {
      refreshed,
      suppressed: !refreshed && this.enabled.size > 0,
      nextRefreshAt: this.nextRefreshAt,
      nextAllowedAt: iso(this.nextAt(true)),
    };
  }

  fetchProvider(id, state) {
    const startedAt = this.now();
    state.lastAttemptAt = startedAt;
    // Defer invocation so even synchronous failures share the same in-flight promise.
    state.inFlight = Promise.resolve().then(() => {
      this.diagnostic(id, 'refresh_started', startedAt);
      return this.providers.get(id)();
    }).then((value) => {
      state.good = cleanSnapshot(value, id);
      state.lastSuccessAt = this.now();
      state.error = null;
      state.blockedUntil = 0;
      state.rateLimitFailures = 0;
      state.transientFailures = 0;
      this.diagnostic(id, 'refresh_succeeded', state.lastSuccessAt, {
        durationMs: state.lastSuccessAt - startedAt,
      });
    }).catch((error) => {
      const failedAt = this.now();
      state.error = safeError(error);
      if (state.error.code === 'rate_limited') {
        state.rateLimitFailures += 1;
        state.transientFailures = 0;
        const retryAfter = error?.retryAfterMs;
        const fallback = this.backoff(state.rateLimitFailures);
        const delay = typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0 && retryAfter <= 8.64e15 - failedAt ? retryAfter : fallback;
        state.blockedUntil = failedAt + Math.max(MIN_REFRESH_INTERVAL_MS, delay);
      } else {
        state.rateLimitFailures = 0;
        if (SLOW_RETRY_CODES.has(state.error.code)) {
          state.transientFailures = 0;
          state.blockedUntil = failedAt + SLOW_RETRY_MS;
        } else {
          state.transientFailures += 1;
          state.blockedUntil = failedAt + this.backoff(state.transientFailures);
        }
      }
      this.diagnostic(id, 'refresh_failed', failedAt, {
        durationMs: failedAt - startedAt,
        errorCode: state.error.code,
        nextRetryAt: this.dueAt(state),
      });
    }).finally(() => {
      state.inFlight = null;
      this.schedule();
    });
    return state.inFlight;
  }

  backoff(failures) {
    const sample = this.random();
    const jitter = 0.8 + (Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0.5) * 0.4;
    return Math.max(MIN_REFRESH_INTERVAL_MS, Math.min(MAX_BACKOFF_MS,
      this.intervalMs * 2 ** Math.min(10, failures - 1) * jitter));
  }

  // Build records from fixed fields only; raw errors and provider payloads never reach observers.
  diagnostic(providerId, event, at, details = {}) {
    if (!this.onDiagnostic || !ORDER.includes(providerId) || !DIAGNOSTIC_EVENTS.has(event)) return;
    const record = { providerId, event, at: iso(at) };
    if (Number.isFinite(details.durationMs)) record.durationMs = Math.max(0, details.durationMs);
    if (Object.hasOwn(ERROR_MESSAGES, details.errorCode)) record.errorCode = details.errorCode;
    if (Number.isFinite(details.nextRetryAt)) record.nextRetryAt = iso(details.nextRetryAt);
    try {
      // Diagnostics are observational: neither a throw nor a rejected promise may affect refresh.
      Promise.resolve(this.onDiagnostic(Object.freeze(record))).catch(() => {});
    } catch {}
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.running) return;
    const due = [...this.enabled].map((id) => this.states.get(id)).filter((state) => !state.inFlight).map((state) => this.dueAt(state));
    if (!due.length) return;
    // setTimeout overflows above 2^31-1; re-evaluate very long Retry-After values daily.
    const wait = Math.min(86_400_000, Math.max(0, Math.min(...due) - this.now()));
    this.timer = setTimeout(() => { void this.refresh(); }, wait);
    this.timer.unref?.();
  }
}
