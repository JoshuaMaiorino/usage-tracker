import { readCredentials, selectCredential } from './credentials.js';
import { LOGIN_COMMANDS, ProviderError } from './providers/shared.js';

const PROVIDERS = [{ id: 'claude', name: 'Claude' }, { id: 'chatgpt', name: 'ChatGPT' }, { id: 'grok', name: 'Grok' }];

export async function discoverAccounts({ homeDir } = {}) {
  return Promise.all(PROVIDERS.map(async ({ id, name }) => {
    const base = { id, name, found: false, status: 'missing', plan: null, loginCommand: LOGIN_COMMANDS[id] };
    try {
      const { data } = await readCredentials(id, { homeDir });
      const credential = selectCredential(id, data);
      return { ...base, found: true, status: 'found', plan: credential.plan, ...(credential.email ? { email: credential.email } : {}) };
    } catch (error) {
      if (process.platform === 'darwin' && id === 'claude' && error?.code === 'missing') {
        return { ...base, status: 'unsupported', message: 'Claude may use the macOS Keychain. This app currently supports file credentials only.' };
      }
      return { ...base, status: error instanceof ProviderError ? error.code : 'unreadable', message: error instanceof ProviderError ? error.message : 'Could not read the local CLI credential file.' };
    }
  }));
}
