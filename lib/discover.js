import { listAccounts } from './accounts.js';
import { readCredentials, selectCredential } from './credentials.js';
import { ProviderError } from './providers/shared.js';

/**
 * Metadata for every local CLI login: which accounts exist, their plan, and why one
 * cannot be used. Tokens never leave this module. Each record also carries the
 * credential file the server needs to build that account's provider; `server.js`
 * serves only the public subset.
 */
export async function discoverAccounts({ homeDir, env } = {}) {
  const accounts = await listAccounts({ homeDir, env });
  return Promise.all(accounts.map(async account => {
    const { id, type, name, credentialFile, loginCommand, email: knownEmail } = account;
    const base = { id, type, name, credentialFile, found: false, status: 'missing', plan: null, loginCommand, ...(knownEmail ? { email: knownEmail } : {}) };
    try {
      const { data } = await readCredentials(id, { homeDir, path: credentialFile });
      const credential = selectCredential(id, data);
      return { ...base, found: true, status: 'found', plan: credential.plan, ...(credential.email ? { email: credential.email } : {}) };
    } catch (error) {
      if (process.platform === 'darwin' && type === 'claude' && error?.code === 'missing') {
        return { ...base, status: 'unsupported', message: 'Claude may use the macOS Keychain. This app currently supports file credentials only.' };
      }
      return { ...base, status: error instanceof ProviderError ? error.code : 'unreadable', message: error instanceof ProviderError ? error.message : 'Could not read the local CLI credential file.' };
    }
  }));
}
