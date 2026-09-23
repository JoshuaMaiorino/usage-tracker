import { claudePlan, credentialPath, readCredentials, replaceCredentials, selectCredential, serializeCredentials, withClaudeRefreshLock } from '../credentials.js';
import { normalizeClaude } from '../normalize.js';
import { authError, coalesce, requestJson, tokenString } from './shared.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const PROFILE_TTL_MS = 3_600_000;
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

// `id`/`name` identify which local Claude login this provider serves; `credentialFile`
// is that account's config directory. The defaults are the canonical `~/.claude` account.
export function createClaudeProvider({ homeDir, id = 'claude', name = 'Claude', credentialFile, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const file = credentialFile ?? credentialPath('claude', homeDir);
  const read = async () => {
    const snapshot = await readCredentials(id, { homeDir, path: file });
    return { snapshot, credential: selectCredential(id, snapshot.data) };
  };
  const refresh = (previousToken, force = false) => serializeCredentials(file, () =>
    withClaudeRefreshLock(file, async validate => {
      const { credential } = await read();
      if (credential.accessToken !== previousToken) return credential;
      if (!force && (!credential.expiresAt || credential.expiresAt > now() + 300_000)) return credential;
      if (!tokenString(credential.refreshToken)) throw authError(id);
      const body = { grant_type: 'refresh_token', refresh_token: credential.refreshToken, client_id: CLIENT_ID };
      if (Array.isArray(credential.entry.scopes) && credential.entry.scopes.every(scope => typeof scope === 'string')) body.scope = credential.entry.scopes.join(' ');
      await validate();
      let result;
      try {
        result = await requestJson(fetchImpl, TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) }, { id, refresh: true, now });
      } catch (error) {
        const latest = await read();
        if (latest.credential.accessToken !== credential.accessToken) return latest.credential;
        throw error;
      }
      if (!tokenString(result.access_token) || typeof result.expires_in !== 'number' || !Number.isFinite(result.expires_in) || result.expires_in <= 0) throw authError(id);
      const latest = await read();
      if (latest.credential.accessToken !== credential.accessToken || latest.credential.refreshToken !== credential.refreshToken) return latest.credential;
      const updated = structuredClone(latest.snapshot.data);
      updated.claudeAiOauth.accessToken = result.access_token;
      updated.claudeAiOauth.expiresAt = now() + result.expires_in * 1000;
      if (tokenString(result.refresh_token)) updated.claudeAiOauth.refreshToken = result.refresh_token;
      if (typeof result.scope === 'string') updated.claudeAiOauth.scopes = result.scope.split(/\s+/).filter(Boolean);
      const written = await replaceCredentials(latest.snapshot, updated, { validate });
      return written ? selectCredential(id, updated) : (await read()).credential;
    }));

  const get = (url, credential) => requestJson(fetchImpl, url, { headers: {
    Authorization: `Bearer ${credential.accessToken}`, Accept: 'application/json',
    'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01',
  } }, { id, now });
  const usage = credential => get(USAGE_URL, credential);

  // The live plan, checked at most hourly. Best effort: on any failure keep the
  // last profile answer, or fall back to the plan the CLI recorded at login.
  let profile = { plan: null, checkedAt: -Infinity };
  const livePlan = async credential => {
    if (now() - profile.checkedAt < PROFILE_TTL_MS) return profile.plan;
    try {
      const org = (await get(PROFILE_URL, credential)).organization;
      const type = typeof org?.organization_type === 'string' ? org.organization_type.replace(/^claude_/, '') : null;
      profile = { plan: claudePlan(type, org?.rate_limit_tier), checkedAt: now() };
    } catch {
      profile = { ...profile, checkedAt: now() };
    }
    return profile.plan;
  };

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
    return normalizeClaude(payload, { plan: (await livePlan(credential)) ?? credential.plan, id, name });
  });
}
