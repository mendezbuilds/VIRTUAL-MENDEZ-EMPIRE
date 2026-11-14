import type {
  LLMCompletionRequest,
  LLMCompletionResponse,
} from '@vme/shared-types';
import type { ModelProviderAdapter } from './mock-llm-provider.js';

export class ModelGateway {
  private adapters = new Map<string, ModelProviderAdapter>();

  registerAdapter(adapter: ModelProviderAdapter): void {
    this.adapters.set(adapter.providerName, adapter);
  }

  async complete(
    provider: 'mock' | 'anthropic' | 'openai' | 'gemini',
    request: LLMCompletionRequest
  ): Promise<LLMCompletionResponse> {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(`Model provider adapter not registered for: ${provider}`);
    }

    return adapter.complete(request);
  }
}

