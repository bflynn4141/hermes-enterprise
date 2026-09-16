// The provider registry.
//
// One function decides which adapter serves a transport, and it is the only
// place that knows. The engine asks for a transport and gets an interface; a
// test hands it a `ScriptedProvider` for the same transport and nothing else
// changes. That substitution is the reason the interface exists.
import type { Transport } from '@hermes/shared';
import type { Env } from '../env.js';
import { AnthropicProvider } from './anthropic.js';
import { DeepSeekProvider } from './deepseek.js';
import { OpenAiProvider } from './openai.js';
import { OpenRouterProvider } from './openrouter.js';
import { NousPortalProvider } from './nous.js';
import { gatewayRouting, type GatewayConfig } from './gateway.js';
import type { AdapterOptions, ModelProvider } from './types.js';

export * from './types.js';
export * from './catalog.js';
export * from './usage.js';
export * from './gateway.js';
export { AnthropicProvider } from './anthropic.js';
export { DeepSeekProvider } from './deepseek.js';
export { OpenAiProvider } from './openai.js';
export { OpenRouterProvider, OPENROUTER_BASE, OpenRouterCreditsError } from './openrouter.js';
export * from './openrouter-catalog.js';
export { NousPortalProvider, NOUS_PORTAL_BASE, NousPortalCreditsError } from './nous.js';
export {
  normaliseNousModels,
  syncNousPortalCatalog,
  type NousPortalModel,
  type SyncRow as NousSyncRow,
  type SyncResult as NousSyncResult,
} from './nous-catalog.js';
export { SCRIPTS, ScriptedProvider, type Script, type ScriptName } from './scripted.js';
export { readSse } from './sse.js';

export function providerForTransport(transport: Transport, options: AdapterOptions = {}): ModelProvider {
  switch (transport) {
    case 'anthropic_messages':
      return new AnthropicProvider(options);
    case 'deepseek_chat':
      return new DeepSeekProvider(options);
    case 'openai_responses':
      return new OpenAiProvider(options);
    case 'openrouter_chat':
      return new OpenRouterProvider(options);
    case 'nous_chat':
      return new NousPortalProvider(options);
  }
}

/** The transport each provider's verification probe uses. */
const VERIFY_TRANSPORT: Readonly<Record<string, Transport>> = {
  anthropic: 'anthropic_messages',
  deepseek: 'deepseek_chat',
  openai: 'openai_responses',
  openrouter: 'openrouter_chat',
  nous_portal: 'nous_chat',
};

export function providerForName(provider: string, options: AdapterOptions = {}): ModelProvider {
  const transport = VERIFY_TRANSPORT[provider];
  if (transport === undefined) throw new Error(`no adapter for provider ${provider}`);
  return providerForTransport(transport, options);
}

/**
 * Adapter options for this environment: the gateway if it is on, otherwise
 * nothing. `gatewayConfig` is null until an environment carries one; the mode
 * var alone is not enough to route anywhere, which is why both are required.
 */
export function adapterOptions(env: Env, gatewayConfig: GatewayConfig | null = null): AdapterOptions {
  return { gateway: gatewayRouting(env, gatewayConfig) };
}
