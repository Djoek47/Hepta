import { describe, expect, it } from 'vitest';
import type { ClaudeLike, FinalMessage, StreamEvent } from '../src/claude.js';
import { ANSWER_SCHEMA, haikuTransport, JEV_SYSTEM } from '../src/haiku.js';

function fakeClient(text: string, stop = 'end_turn') {
  const calls: Record<string, unknown>[] = [];
  const client: ClaudeLike = {
    messages: {
      stream(params) {
        calls.push(params);
        const events: StreamEvent[] = [{ type: 'message_start' }, ...[text.slice(0, 10), text.slice(10)].map((t) => ({ type: 'content_block_delta', delta: { type: 'text_delta', text: t } }))];
        const msg: FinalMessage = { stop_reason: stop, content: [{ type: 'text', text }], usage: { input_tokens: 900, output_tokens: 60, cache_read_input_tokens: 800 } };
        return Object.assign({ async *[Symbol.asyncIterator]() { for (const e of events) yield e; } }, { finalMessage: async () => msg });
      },
    },
  };
  return { client, calls };
}

const QUESTIONS = [
  { type: 'choice' as const, key: 'shift', question: '?', criteria: { none: 'none', diversion: 'diversion', follow_up: 'follow_up', natural: 'natural' } },
  { type: 'noul' as const, key: 'addressed', question: '?' },
];

describe('Claude Haiku as a Jev transport', () => {
  it('asks Haiku with thinking off, low effort, one fixed schema and a cached system prompt', async () => {
    const { client, calls } = fakeClient('{"answers":[]}');
    await haikuTransport({ client })({ model: 'x', state: {}, questions: QUESTIONS });
    const p = calls[0]!;
    expect(p.model).toBe('claude-haiku-5-5');
    expect(p.thinking).toEqual({ type: 'disabled' });
    expect(p.output_config).toEqual({ effort: 'low', format: { type: 'json_schema', schema: ANSWER_SCHEMA } });
    expect(p.system).toEqual([{ type: 'text', text: JEV_SYSTEM, cache_control: { type: 'ephemeral' } }]);
    expect(p).not.toHaveProperty('temperature');
  });

  it('keeps the system prompt above the 512-token caching minimum and free of anything volatile', () => {
    expect(JEV_SYSTEM.length / 4).toBeGreaterThan(700);
    expect(JEV_SYSTEM).not.toMatch(/\d{4}-\d{2}-\d{2}|Date\.now/);
  });

  it('maps answers back, drops options nobody declared, and reports timing', async () => {
    const { client } = fakeClient(JSON.stringify({ answers: [
      { key: 'shift', choice: 'diversion', p: 0.7, alt: 'follow_up', alt_p: 0.2 },
      { key: 'addressed', choice: 'no', p: 0.9, alt: '', alt_p: 0 },
      { key: 'shift', choice: 'sideways', p: 0.9, alt: '', alt_p: 0 },
    ] }));
    let timing: { ttftMs: number; totalMs: number; cacheReadTokens?: number } | null = null;
    const res = await haikuTransport({ client, onTiming: (t) => { timing = t; } })({ model: 'x', state: {}, questions: QUESTIONS });
    expect(res.answers).toEqual([
      { key: 'shift', choice: 'diversion', probabilities: { diversion: 0.7, follow_up: 0.2 }, confidence: 0.7 },
      { key: 'addressed', noul: expect.closeTo(0.1, 5), confidence: 0.9 },
    ]);
    expect(timing!.ttftMs).toBeLessThanOrEqual(timing!.totalMs);
    expect(timing!.cacheReadTokens).toBe(800);
  });

  it('refuses to guess from a refusal or a cut-off answer', async () => {
    await expect(haikuTransport({ client: fakeClient('{}', 'refusal').client })({ model: 'x', state: {}, questions: QUESTIONS })).rejects.toThrow(/refused/);
    await expect(haikuTransport({ client: fakeClient('{"answers":[', 'max_tokens').client })({ model: 'x', state: {}, questions: QUESTIONS })).rejects.toThrow(/max_tokens/);
  });
});
