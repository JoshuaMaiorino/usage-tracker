import { credentialPath, readCredentials, replaceCredentials, selectCredential, serializeCredentials, withClaudeRefreshLock } from '../credentials.js';
import { normalizeClaude } from '../normalize.js';
import { authError, coalesce, requestJson, tokenString } from './shared.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

export function createClaudeProvider({ homeDir, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const read = async () => {
    const snapshot = await readCredentials('claude', { homeDir });
    return { snapshot, credential: selectCredential('claude', snapshot.data) };
  };
  const refresh = (previousToken, force = false) => serializeCredentials(credentialPath('claude', homeDir), () =>
    withClaudeRefreshLock(credentialPath('claude', homeDir), async validate => {
      const { credential } = await read();
      if (credential.accessToken !== previousToken) return credential;
      if (!force && (!credential.expiresAt || credential.expiresAt > now() + 300_000)) return credential;
      if (!tokenString(credential.refreshToken)) throw authError('claude');
      const body = { grant_type: 'refresh_token', refresh_token: credential.refreshToken, client_id: CLIENT_ID };
      if (Array.isArray(credential.entry.scopes) && credential.entry.scopes.every(scope => typeof scope === 'string')) body.scope = credential.entry.scopes.join(' ');
      await validate();
      let result;
      try {
        result = await requestJson(fetchImpl, TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) }, { id: 'claude', refresh: true, now });
      } catch (error) {
        const latest = await read();
        if (latest.credential.accessToken !== credential.accessToken) return latest.credential;
        throw error;
      }
      if (!tokenString(result.access_token) || typeof result.expires_in !== 'number' || !Number.isFinite(result.expires_in) || result.expires_in <= 0) throw authError('claude');
      const latest = await read();
      if (latest.credential.accessToken !== credential.accessToken || latest.credential.refreshToken !== credential.refreshToken) return latest.credential;
      const updated = structuredClone(latest.snapshot.data);
      updated.claudeAiOauth.accessToken = result.access_token;
      updated.claudeAiOauth.expiresAt = now() + result.expires_in * 1000;
      if (tokenString(result.refresh_token)) updated.claudeAiOauth.refreshToken = result.refresh_token;
      if (typeof result.scope === 'string') updated.claudeAiOauth.scopes = result.scope.split(/\s+/).filter(Boolean);
      const written = await replaceCredentials(latest.snapshot, updated, { validate });
      return written ? selectCredential('claude', updated) : (await read()).credential;
    }));

  const usage = credential => requestJson(fetchImpl, USAGE_URL, { headers: {
    Authorization: `Bearer ${credential.accessToken}`, Accept: 'application/json',
    'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01',
  } }, { id: 'claude', now });

  return coalesce(async () => {
    let { credential } = await read();
    let refreshed = false;
    if (credential.expiresAt && credential.expiresAt <= now() + 300_000) {
      credential = await refresh(credential.accessToken);
      refreshed = true;
    }
    let payload;
    try { payload = await usage(credential); } catch (error) {
      if (error.code !== 'auth') throw error;
      const latest = (await read()).credential;
      if (latest.accessToken !== credential.accessToken) credential = latest;
      else if (!refreshed) credential = await refresh(credential.accessToken, true);
      else throw error;
      payload = await usage(credential);
    }
    return normalizeClaude(payload, { plan: credential.plan });
  });
}
