/**
 * Thin Anthropic client for the discovery loop. We drive the tool-use loop
 * ourselves (rather than a helper runner) so every tool call passes through the
 * guard and observability layers before it touches the surface.
 */
import Anthropic from '@anthropic-ai/sdk';

export const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5';

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LlmTurn {
  text: string;
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
  stopReason: string | null;
}

export class Llm {
  private client: Anthropic;
  constructor(
    readonly model = DEFAULT_MODEL,
    apiKey = process.env.ANTHROPIC_API_KEY,
  ) {
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set — required for the discovery run.');
    this.client = new Anthropic({ apiKey });
  }

  async turn(system: string, messages: Anthropic.MessageParam[], tools: ToolDef[]): Promise<{ turn: LlmTurn; assistant: Anthropic.MessageParam }> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 1500,
      system,
      messages,
      tools: tools as Anthropic.Tool[],
      tool_choice: { type: 'any' },
    });

    const toolCalls: LlmTurn['toolCalls'] = [];
    let text = '';
    for (const block of res.content) {
      if (block.type === 'text') text += block.text;
      if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: block.input as Record<string, unknown> });
    }
    return {
      turn: { text, toolCalls, stopReason: res.stop_reason },
      assistant: { role: 'assistant', content: res.content },
    };
  }
}
