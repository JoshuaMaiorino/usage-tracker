import { credentialPath, readCredentials, replaceCredentials, selectCredential, serializeCredentials } from '../credentials.js';
import { normalizeChatgpt } from '../normalize.js';
import { authError, coalesce, requestJson, tokenString } from './shared.js';

const BASE_URL = 'https://chatgpt.com/backend-api/wham';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

export function createChatgptProvider({ homeDir, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const read = async () => {
    const snapshot = await readCredentials('chatgpt', { homeDir });
    return { snapshot, credential: selectCredential('chatgpt', snapshot.data) };
  };
  const refresh = previousToken => serializeCredentials(credentialPath('chatgpt', homeDir), async () => {
    const { credential } = await read();
    if (credential.accessToken !== previousToken) return credential;
    if (!tokenString(credential.refreshToken)) throw authError('chatgpt');
    let result;
    try {
      result = await requestJson(fetchImpl, TOKEN_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: credential.refreshToken, client_id: CLIENT_ID }),
      }, { id: 'chatgpt', refresh: true, now });
    } catch (error) {
      const latest = await read();
      if (latest.credential.accessToken !== credential.accessToken) return latest.credential;
      throw error;
    }
    if (!tokenString(result.access_token)) throw authError('chatgpt');
    const latest = await read();
    if (latest.credential.accessToken !== credential.accessToken || latest.credential.refreshToken !== credential.refreshToken) return latest.credential;
    const updated = structuredClone(latest.snapshot.data);
    updated.tokens.access_token = result.access_token;
    if (tokenString(result.refresh_token)) updated.tokens.refresh_token = result.refresh_token;
    if (tokenString(result.id_token)) updated.tokens.id_token = result.id_token;
    updated.last_refresh = new Date(now()).toISOString();
    const written = await replaceCredentials(latest.snapshot, updated);
    return written ? selectCredential('chatgpt', updated) : (await read()).credential;
  });
  const get = (path, credential) => {
    const headers = { Authorization: `Bearer ${credential.accessToken}`, Accept: 'application/json', 'OpenAI-Beta': 'codex-1' };
    if (tokenString(credential.accountId)) headers['ChatGPT-Account-Id'] = credential.accountId;
    return requestJson(fetchImpl, `${BASE_URL}/${path}`, { headers }, { id: 'chatgpt', now });
  };
  return coalesce(async () => {
    let { credential } = await read();
    let payload;
    try { payload = await get('usage', credential); } catch (error) {
      if (error.code !== 'auth') throw error;
      credential = await refresh(credential.accessToken);
      payload = await get('usage', credential);
    }
    let resetCredits;
    if (typeof payload.rate_limit_reset_credits?.available_count === 'number' && payload.rate_limit_reset_credits.available_count > 0) {
      try { resetCredits = await get('rate-limit-reset-credits', credential); } catch { /* optional metadata cannot discard usage */ }
    }
    return normalizeChatgpt(payload, { plan: credential.plan, resetCredits });
  });
}
