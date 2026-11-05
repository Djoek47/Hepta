/**
 * The one place that builds a Claude client. Keys come from the environment
 * (.env is loaded by the apps); with no key there is no client, and every
 * caller has a local path that works without one.
 */
import Anthropic from '@anthropic-ai/sdk';

export const HAIKU = 'claude-haiku-5-5';
export const SONNET = 'claude-sonnet-5-5';

/** The slice of the SDK this package uses, so tests can stand in for it. */
export type StreamEvent = { type: string; delta?: { type: string; text?: string } };
export type FinalMessage = {
  stop_reason: string | null;
  content: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
  model?: string;
};
export type StreamLike = AsyncIterable<StreamEvent> & { finalMessage(): Promise<FinalMessage>; abort?(): void };
export type ClaudeLike = {
  messages: { stream(params: Record<string, unknown>, opts?: { signal?: AbortSignal }): StreamLike };
  beta?: { messages: { stream(params: Record<string, unknown>, opts?: { signal?: AbortSignal }): StreamLike } };
};

export function claudeClient(env: Record<string, string | undefined> = process.env): ClaudeLike | null {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  // A short timeout and one retry: a listener that waits ten minutes for an answer has stopped listening.
  return new Anthropic({ apiKey, timeout: 20_000, maxRetries: 1 }) as unknown as ClaudeLike;
}

export function textOf(m: FinalMessage): string {
  return m.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
}
