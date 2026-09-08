import { readCredentials, selectCredential } from '../credentials.js';
import { normalizeGrok } from '../normalize.js';
import { ProviderError, authError, coalesce, requestJson, tokenString } from './shared.js';

const BASE_URL = 'https://cli-chat-proxy.grok.com/v1';

function needsCli(credential) {
  if (!tokenString(credential.refreshToken)) throw authError('grok');
  // Grok uses an OS advisory lock with holder heartbeat, not a lockfile
  // existence test. Node core cannot participate portably. Never send its
  // rotating refresh token or modify/break the CLI's auth.json.lock.
  throw new ProviderError('refresh_unsupported', 'Open Grok to renew its login, or run grok login. Shared Grok token refresh is not supported safely.');
}

export function createGrokProvider({ homeDir, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const read = async () => selectCredential('grok', (await readCredentials('grok', { homeDir })).data);
  const get = (path, credential) => requestJson(fetchImpl, `${BASE_URL}/${path}`, { headers: {
    Authorization: `Bearer ${credential.accessToken}`, 'x-xai-token-auth': 'xai-grok-cli', Accept: 'application/json',
  } }, { id: 'grok', now });
  return coalesce(async () => {
    let credential = await read();
    if (credential.expiresAt && credential.expiresAt <= now()) needsCli(credential);
    let payload;
    try { payload = await get('billing?format=credits', credential); } catch (error) {
      if (error.code !== 'auth') throw error;
      const latest = await read();
      if (latest.accessToken === credential.accessToken) needsCli(credential);
      credential = latest;
      payload = await get('billing?format=credits', credential);
    }
    let settings;
    try { settings = await get('settings', credential); } catch { /* best effort */ }
    return normalizeGrok(payload, { plan: credential.plan, settings });
  });
}
