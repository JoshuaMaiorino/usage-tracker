// Only recognized, validated usage fields cross the provider boundary.
const FIVE_HOURS = 5 * 60 * 60;
const WEEK = 7 * 24 * 60 * 60;

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 160) : null;
}

function creditBalance(value) {
  if (number(value) !== null) return String(value);
  // Codex encodes decimal balances as strings. This exception is never used for meters.
  if (typeof value === 'string' && value.length <= 80 && /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value))) return value;
  return null;
}

function timestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  let milliseconds;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    milliseconds = value < 1e12 ? value * 1000 : value;
  } else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    milliseconds = Date.parse(value);
  } else {
    return null;
  }
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function title(value) {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function durationLabel(seconds) {
  if (seconds === FIVE_HOURS) return 'Session · 5 hours';
  if (seconds === WEEK) return 'Weekly · 7 days';
  if (seconds >= 86400 && seconds % 86400 === 0) return `${seconds / 86400}-day window`;
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}-hour window`;
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}-minute window`;
  return `${seconds}-second window`;
}

function durationId(seconds) {
  if (seconds === FIVE_HOURS) return 'session';
  if (seconds === WEEK) return 'weekly';
  return `window-${seconds}`;
}

function finish(provider) {
  if (provider.windows.length === 0) {
    const error = new Error('Usage format changed — parser needs updating.');
    error.code = 'format';
    throw error;
  }
  return provider;
}

function moneyFromCents(cents) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

export function normalizeClaude(payload, metadata = {}) {
  const data = object(payload);
  const result = { id: 'claude', name: 'Claude', plan: text(metadata.plan), windows: [], extras: [] };
  for (const [key, raw] of Object.entries(data)) {
    const match = /^(five_hour|seven_day)(?:_(.+))?$/.exec(key);
    if (!match) continue;
    const value = object(raw);
    const usedPercent = number(value.utilization);
    if (usedPercent === null) continue;
    const durationSeconds = match[1] === 'five_hour' ? FIVE_HOURS : WEEK;
    const scope = match[2] ? title(match[2]) : null;
    result.windows.push({
      id: scope ? `${durationId(durationSeconds)}-${match[2]}` : durationId(durationSeconds),
      label: scope ? `${scope} · ${durationSeconds === WEEK ? 'weekly' : '5 hours'}` : durationLabel(durationSeconds),
      usedPercent,
      resetsAt: timestamp(value.resets_at),
      durationSeconds,
      ...(scope ? { scope } : {}),
    });
  }
  result.windows.sort((a, b) => Number(Boolean(a.scope)) - Number(Boolean(b.scope)) || a.durationSeconds - b.durationSeconds);
  const extra = object(data.extra_usage);
  if (extra.is_enabled === true) {
    const used = number(extra.used_credits);
    const limit = number(extra.monthly_limit);
    if (used !== null) {
      result.extras.push({ label: 'Extra usage', value: `${moneyFromCents(used)}${limit === null ? '' : ` / ${moneyFromCents(limit)}`}` });
    }
  }
  return finish(result);
}

export function normalizeChatgpt(payload, metadata = {}) {
  const data = object(payload);
  const result = {
    id: 'chatgpt', name: 'ChatGPT', plan: text(metadata.plan) ?? text(data.plan_type), windows: [], extras: [],
  };
  const addLimit = (limit, scope = null, scopeId = null) => {
    for (const raw of [object(limit).primary_window, object(limit).secondary_window]) {
      const value = object(raw);
      const usedPercent = number(value.used_percent);
      const durationSeconds = number(value.limit_window_seconds);
      // An unnamed window without its duration cannot safely be called session or weekly.
      if (usedPercent === null || durationSeconds === null || durationSeconds <= 0) continue;
      const id = `${scopeId ? `${scopeId}-` : ''}${durationId(durationSeconds)}`;
      if (result.windows.some((window) => window.id === id)) continue;
      result.windows.push({
        id,
        label: scope ? `${scope} · ${durationLabel(durationSeconds).toLowerCase()}` : durationLabel(durationSeconds),
        usedPercent,
        resetsAt: timestamp(value.reset_at),
        durationSeconds,
        ...(scope ? { scope } : {}),
      });
    }
  };
  addLimit(data.rate_limit);
  if (Array.isArray(data.additional_rate_limits)) {
    for (const raw of data.additional_rate_limits) {
      const limit = object(raw);
      const scope = text(limit.limit_name) ?? text(limit.metered_feature);
      if (!scope) continue;
      const scopeId = `${text(limit.metered_feature) ?? 'limit'}-${scope}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      addLimit(limit.rate_limit, scope, scopeId);
    }
  }
  // This named limit has its own scope and must not replace the general weekly window.
  if (Object.keys(object(data.code_review_rate_limit)).length) addLimit(data.code_review_rate_limit, 'Code review', 'code-review');
  result.windows.sort((a, b) => Number(Boolean(a.scope)) - Number(Boolean(b.scope)) || a.durationSeconds - b.durationSeconds);
  const credits = object(data.credits);
  if (credits.unlimited === true) result.extras.push({ label: 'Credits', value: 'Unlimited' });
  else if (creditBalance(credits.balance) !== null) result.extras.push({ label: 'Credits', value: creditBalance(credits.balance) });
  const available = number(object(data.rate_limit_reset_credits).available_count);
  if (available !== null) result.extras.push({ label: 'Banked resets', value: String(available) });
  const resetCredits = object(metadata.resetCredits);
  const expiresAt = timestamp(resetCredits.expires_at ?? resetCredits.next_expiration_at);
  if (available !== null && available > 0 && expiresAt) {
    result.extras.push({ label: 'Reset credits expire', value: expiresAt });
  }
  return finish(result);
}

export function normalizeGrok(payload, metadata = {}) {
  const data = object(payload);
  const config = object(data.config);
  const settings = object(metadata.settings);
  const result = {
    id: 'grok', name: 'Grok',
    plan: text(metadata.plan) ?? text(settings.subscription_tier_display),
    windows: [], extras: [],
  };
  let usedPercent = number(config.creditUsagePercent);
  if (usedPercent === null) {
    for (const source of [config, data]) {
      const used = number(source.onDemandUsed);
      const cap = number(source.onDemandCap);
      if (used !== null && cap !== null && cap > 0) {
        const ratio = (used / cap) * 100;
        if (Number.isFinite(ratio)) usedPercent = ratio;
        break;
      }
    }
  }
  if (usedPercent !== null) {
    result.windows.push({
      id: 'weekly', label: 'Shared weekly pool', usedPercent,
      resetsAt: timestamp(object(config.currentPeriod).end ?? config.billingPeriodEnd),
      durationSeconds: WEEK,
    });
  }
  for (const [field, label] of [['prepaidCredits', 'Prepaid credits'], ['extraCredits', 'Extra credits']]) {
    const amount = number(data[field] ?? config[field]);
    if (amount !== null) result.extras.push({ label, value: String(amount) });
  }
  const breakdown = object(data.productUsage ?? config.productUsage);
  for (const key of ['chat', 'imagine', 'voice', 'build']) {
    const entry = object(breakdown[key]);
    const percent = number(entry.creditUsagePercent);
    if (percent !== null) result.extras.push({ label: title(key), value: `${percent}% used` });
  }
  return finish(result);
}
