import { createClaudeProvider } from './claude.js';
import { createChatgptProvider } from './chatgpt.js';
import { createGrokProvider } from './grok.js';

export function createProviders(options = {}) {
  return {
    claude: createClaudeProvider(options),
    chatgpt: createChatgptProvider(options),
    grok: createGrokProvider(options),
  };
}
