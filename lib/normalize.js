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

function relativeTimestamp(seconds, now) {
  if (number(seconds) === null || typeof now !== 'number' || !Number.isFinite(now)) return null;
  const date = new Date(now + seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function claudeCanonicalWindows(limits) {
  if (!Array.isArray(limits)) return [];
  const durations = { session: FIVE_HOURS, session_scoped: FIVE_HOURS, five_hour: FIVE_HOURS, weekly: WEEK, weekly_all: WEEK, weekly_scoped: WEEK, seven_day: WEEK };
  const windows = [];
  for (const raw of limits) {
    const limit = object(raw);
    const kind = text(limit.kind);
    const group = text(limit.group);
    const usedPercent = number(limit.percent ?? limit.utilization);
    const durationSeconds = Object.hasOwn(durations, kind) ? durations[kind]
      : Object.hasOwn(durations, group) ? durations[group] : null;
    if (usedPercent === null || durationSeconds === null) continue;
    const scopeData = object(limit.scope);
    const model = object(scopeData.model);
    const surface = scopeData.surface;
    const modelName = text(model.display_name) ?? text(model.id);
    const surfaceName = text(object(surface).display_name) ?? text(object(surface).id) ?? text(surface);
    const scope = [modelName, surfaceName].filter(Boolean).join(' · ') || null;
    // An unnamed scoped limit must not masquerade as an account-wide allowance.
    if (!scope && (kind?.endsWith('_scoped') || Object.values(scopeData).some(value => value != null))) continue;
    const scopeId = [text(model.id) ?? modelName, text(object(surface).id) ?? surfaceName].filter(Boolean)
      .map(value => encodeURIComponent(value.toWellFormed().toLowerCase().replace(/[_\s]+/g, '-'))).join('--');
    const id = `${durationId(durationSeconds)}${scopeId ? `-${scopeId}` : ''}`;
    if (windows.some(window => window.id === id)) continue;
    windows.push({
      id,
      label: scope ? `${scope} · ${durationSeconds === WEEK ? 'weekly' : '5 hours'}` : durationLabel(durationSeconds),
      usedPercent,
      resetsAt: timestamp(limit.resets_at ?? limit.reset_at),
      durationSeconds,
      ...(scope ? { scope } : {}),
    });
  }
  return windows;
}

function finish(provider) {
  if (provider.windows.length === 0) {
    const error = new Error('Usage format changed — parser needs updating.');
    error.code = 'format';
    throw error;
  }
  return provider;
}

function moneyFromMinor(amount, currency, exponent) {
  if (number(amount) === null || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency) || !Number.isInteger(exponent) || exponent < 0 || exponent > 6) return null;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: exponent, maximumFractionDigits: exponent }).format(amount / 10 ** exponent);
}

function structuredMoney(raw) {
  const value = object(raw);
  return moneyFromMinor(value.amount_minor, value.currency, value.exponent);
}

function claudeMoney(amount, extra) {
  const currency = extra.currency ?? 'USD';
  // The official CLI's legacy currency format uses whole units for these currencies.
  const exponent = extra.decimal_places ?? (['JPY', 'KRW', 'VND'].includes(currency) ? 0 : 2);
  return moneyFromMinor(amount, currency, exponent);
}

function grokCents(raw) {
  if (typeof raw === 'number') return number(raw);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  // Grok's Cent protobuf omits val for a real zero. Missing/null Cent is unknown.
  if (!Object.hasOwn(raw, 'val')) return Object.keys(raw).length === 0 ? 0 : null;
  const value = raw.val;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.abs(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value))) return Math.abs(Number(value));
  return null;
}

export function normalizeClaude(payload, metadata = {}) {
  const data = object(payload);
  const result = { id: 'claude', name: 'Claude', plan: text(metadata.plan), windows: claudeCanonicalWindows(data.limits), extras: [] };
  // Canonical limits name the active windows; legacy keys can contain decoys.
  // Keep the legacy path for older responses and wholly unrecognized arrays.
  for (const [key, raw] of result.windows.length ? [] : Object.entries(data)) {
    const match = /^(five_hour|seven_day)(?:_(.+))?$/.exec(key);
    if (!match) continue;
    const value = object(raw);
    const usedPercent = number(value.utilization);
    if (usedPercent === null) continue;
    const durationSeconds = match[1] === 'five_hour' ? FIVE_HOURS : WEEK;
    const scope = match[2] ? title(match[2]) : null;
    const resetsAt = timestamp(value.resets_at);
    // No-reset zero model buckets are legacy placeholders. Headline zero is real.
    if (scope && usedPercent === 0 && resetsAt === null) continue;
    result.windows.push({
      id: scope ? `${durationId(durationSeconds)}-${match[2]}` : durationId(durationSeconds),
      label: scope ? `${scope} · ${durationSeconds === WEEK ? 'weekly' : '5 hours'}` : durationLabel(durationSeconds),
      usedPercent,
      resetsAt,
      durationSeconds,
      ...(scope ? { scope } : {}),
    });
  }
  result.windows.sort((a, b) => Number(Boolean(a.scope)) - Number(Boolean(b.scope)) || a.durationSeconds - b.durationSeconds);
  const extra = object(data.extra_usage);
  const spend = object(data.spend);
  const enabled = typeof spend.enabled === 'boolean' ? spend.enabled : extra.is_enabled;
  if (typeof enabled === 'boolean') result.extras.push({ label: 'Usage credits', value: enabled ? 'Enabled' : 'Disabled' });
  const used = structuredMoney(spend.used) ?? claudeMoney(extra.used_credits, extra);
  if (used !== null) result.extras.push({ label: 'Extra usage spent', value: used });
  const monthlyLimit = claudeMoney(extra.monthly_limit, extra);
  const spendLimit = structuredMoney(spend.limit);
  if (spendLimit !== null) result.extras.push({ label: 'Spending limit', value: spendLimit });
  else if (monthlyLimit !== null) result.extras.push({ label: 'Monthly spending limit', value: monthlyLimit });
  else if (enabled === true && extra.monthly_limit === null) result.extras.push({ label: 'Monthly spending limit', value: 'Unlimited' });
  const balance = structuredMoney(spend.balance);
  if (balance !== null) result.extras.push({ label: 'Usage credit balance', value: balance });
  if (extra.spend_limit_reached === true) result.extras.push({ label: 'Spending limit status', value: 'Reached' });
  return finish(result);
}

export function normalizeChatgpt(payload, metadata = {}) {
  const data = object(payload);
  const now = metadata.now ?? Date.now();
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
        resetsAt: timestamp(value.reset_at ?? value.resets_at)
          ?? relativeTimestamp(value.reset_after_seconds ?? value.resets_in_seconds, now),
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
      const used = grokCents(source.onDemandUsed);
      const cap = grokCents(source.onDemandCap);
      if (used !== null && cap !== null && cap > 0) {
        const ratio = (used / cap) * 100;
        if (Number.isFinite(ratio)) usedPercent = ratio;
        break;
      }
    }
  }
  if (usedPercent !== null) {
    const monthly = object(config.currentPeriod).type === 'USAGE_PERIOD_TYPE_MONTHLY';
    result.windows.push({
      id: monthly ? 'monthly' : 'weekly', label: monthly ? 'Shared monthly pool' : 'Shared weekly pool', usedPercent,
      resetsAt: timestamp(object(config.currentPeriod).end ?? config.billingPeriodEnd),
      ...(monthly ? {} : { durationSeconds: WEEK }),
    });
  }
  const prepaid = grokCents(config.prepaidBalance);
  if (prepaid !== null) result.extras.push({ label: 'Extra Usage Credits', value: moneyFromMinor(prepaid, 'USD', 2) });
  // These are legacy on-demand limits; the unified subscription pool has its own meter.
  if (config.isUnifiedBillingUser !== true) {
    const used = grokCents(config.onDemandUsed);
    const cap = grokCents(config.onDemandCap);
    if (used !== null) result.extras.push({ label: 'On-demand spending', value: moneyFromMinor(used, 'USD', 2) });
    if (cap !== null) result.extras.push({ label: 'On-demand spending limit', value: moneyFromMinor(cap, 'USD', 2) });
  }
  const period = object(config.currentPeriod).type;
  if (period === 'USAGE_PERIOD_TYPE_WEEKLY' || period === 'USAGE_PERIOD_TYPE_MONTHLY') {
    result.extras.push({ label: 'Allowance period', value: period === 'USAGE_PERIOD_TYPE_WEEKLY' ? 'Weekly' : 'Monthly' });
  }
  for (const [field, label] of [['prepaidCredits', 'Prepaid credits'], ['extraCredits', 'Extra credits']]) {
    const amount = number(data[field] ?? config[field]);
    if (amount !== null) result.extras.push({ label, value: String(amount) });
  }
  const rawBreakdown = data.productUsage ?? config.productUsage;
  if (Array.isArray(rawBreakdown)) {
    const labels = { chat: 'Chat', imagine: 'Imagine', voice: 'Voice', build: 'Build' };
    const reported = new Set();
    for (const raw of rawBreakdown) {
      const entry = object(raw);
      const key = typeof entry.product === 'string' ? entry.product.toLowerCase().replace(/^product[_ -]*/, '').replace(/^grok[_ -]*/, '') : '';
      const percent = number(entry.usagePercent);
      if (!Object.hasOwn(labels, key) || percent === null || reported.has(key)) continue;
      result.extras.push({ label: `${labels[key]} usage`, value: `${percent}% of total allowance` });
      reported.add(key);
    }
  }
  const breakdown = object(rawBreakdown);
  for (const key of ['chat', 'imagine', 'voice', 'build']) {
    const entry = object(breakdown[key]);
    const percent = number(entry.creditUsagePercent);
    if (percent !== null) result.extras.push({ label: title(key), value: `${percent}% used` });
  }
  return finish(result);
}
