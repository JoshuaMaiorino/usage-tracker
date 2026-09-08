export class ProviderError extends Error {
  constructor(code, message, { status, retryAfterMs } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    if (status) this.status = status;
    if (Number.isFinite(retryAfterMs)) this.retryAfterMs = retryAfterMs;
  }
}

export const LOGIN_COMMANDS = Object.freeze({ claude: 'claude auth login', chatgpt: 'codex login', grok: 'grok login' });
export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const tokenString = value => typeof value === 'string' && value.length > 0 && value.length <= 64_000 && !/[\r\n\0]/.test(value);

export function authError(id) {
  return new ProviderError('auth', `Token expired — run ${LOGIN_COMMANDS[id]}.`, { status: 401 });
}

export function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) && date > now ? date - now : undefined;
}

// Never attach the upstream body, URL, request options, or raw network error.
// All outbound destinations are constants; redirects cannot forward credentials.
export async function requestJson(fetchImpl, url, options = {}, { id, refresh = false, now = Date.now } = {}) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new ProviderError('timeout', 'Provider request timed out. Will retry.');
    }
    throw new ProviderError('network', 'Could not reach the provider. Will retry.');
  }
  if (!response.ok) {
    // Drop, rather than parse or log, error bodies that can echo credentials.
    try { await response.body?.cancel(); } catch { /* best effort */ }
    if (response.status === 429) throw new ProviderError('rate_limited', 'Rate limited — backing off.', {
      status: 429, retryAfterMs: parseRetryAfter(response.headers?.get('retry-after'), now()),
    });
    if (response.status === 401 || (refresh && response.status === 400)) throw authError(id);
    if (response.status === 403) throw new ProviderError('forbidden', 'Provider denied access. Check your CLI subscription login.', { status: 403 });
    throw new ProviderError('provider', 'Provider request failed. Will retry.', { status: response.status });
  }
  try {
    const payload = await response.json();
    if (!isObject(payload)) throw new Error('shape');
    return payload;
  } catch {
    throw new ProviderError('format', 'Usage format changed — parser needs updating.');
  }
}

export function coalesce(work) {
  let pending;
  return (...args) => {
    if (!pending) pending = Promise.resolve().then(() => work(...args)).finally(() => { pending = undefined; });
    return pending;
  };
}
