import type {
  LLMCompletionRequest,
  LLMCompletionResponse,
} from '@vme/shared-types';

export interface ModelProviderAdapter {
  providerName: 'mock' | 'anthropic' | 'openai' | 'gemini';
  complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse>;
}

export class MockLLMProvider implements ModelProviderAdapter {
  public readonly providerName = 'mock';
  private cannedResponses: Map<string, string> = new Map();
  private callHistory: LLMCompletionRequest[] = [];

  registerCannedResponse(promptSubstring: string, response: string): void {
    this.cannedResponses.set(promptSubstring, response);
  }

  getCallHistory(): LLMCompletionRequest[] {
    return [...this.callHistory];
  }

  clearHistory(): void {
    this.callHistory = [];
  }

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    this.callHistory.push(request);

    const userMessage = request.messages.find((m) => m.role === 'user')?.content ?? '';

    // Match canned response
    for (const [key, response] of this.cannedResponses.entries()) {
      if (userMessage.includes(key)) {
        return {
          content: response,
          model: 'mock-llm-v1',
          usage: {
            promptTokens: userMessage.length,
            completionTokens: response.length,
            totalTokens: userMessage.length + response.length,
          },
        };
      }
    }

    // Default autonomous corporate response
    const defaultContent = `[MockLLM] Directive processed successfully for prompt: "${userMessage.slice(0, 40)}..."`;
    return {
      content: defaultContent,
      model: 'mock-llm-v1',
      usage: {
        promptTokens: userMessage.length,
        completionTokens: defaultContent.length,
        totalTokens: userMessage.length + defaultContent.length,
      },
    };
  }
}
