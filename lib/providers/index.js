import { credentialPath } from '../credentials.js';
import { LOGIN_COMMANDS } from './shared.js';
import { createClaudeProvider } from './claude.js';
import { createChatgptProvider } from './chatgpt.js';
import { createGrokProvider } from './grok.js';

const FACTORIES = { claude: createClaudeProvider, chatgpt: createChatgptProvider, grok: createGrokProvider };

/**
 * One fetcher per discovered account. Without an `accounts` list this is the
 * canonical login of each provider, which is the single-subscription default.
 */
export function createProviders({ accounts, ...options } = {}) {
  const list = Array.isArray(accounts) && accounts.length ? accounts : [
    { id: 'claude', type: 'claude', name: 'Claude', credentialFile: credentialPath('claude', options.homeDir), loginCommand: LOGIN_COMMANDS.claude },
    { id: 'chatgpt', type: 'chatgpt', name: 'ChatGPT', credentialFile: credentialPath('chatgpt', options.homeDir), loginCommand: LOGIN_COMMANDS.chatgpt },
    { id: 'grok', type: 'grok', name: 'Grok', credentialFile: credentialPath('grok', options.homeDir), loginCommand: LOGIN_COMMANDS.grok },
  ];
  const providers = {};
  for (const account of list) {
    const factory = FACTORIES[account.type];
    if (!factory) continue;
    providers[account.id] = account.type === 'claude'
      ? factory({ ...options, id: account.id, name: account.name, credentialFile: account.credentialFile })
      : factory(options);
  }
  return providers;
}
