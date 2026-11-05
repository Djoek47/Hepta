import type { DetectState, Heard, Mode, SttChunk } from '../src/types.js';

let n = 0;
export function heard(text: string, over: Partial<Heard> = {}): Heard {
  n++;
  return { id: `h${n}`, utteranceId: `u${n}`, speaker: 'S1', text, final: true, startMs: n * 1000, endMs: n * 1000 + 800,
    atMs: n * 1000 + 900, boundary: true, words: [], ...over };
}

export function state(over: Partial<DetectState> = {}, mode: Mode = 'panel'): DetectState {
  return { mode, nowMs: 0, speakers: [], turns: [], current: { topic: null, keys: [], speaker: null }, threads: [], questions: [],
    claims: [], evidence: [], ...over };
}

/** A chunk with one word per token, all from one recognizer label. */
export function chunk(text: string, over: Partial<SttChunk> & { label?: string; at?: number } = {}): SttChunk {
  const at = over.at ?? 0;
  const toks = text.split(/\s+/).filter(Boolean);
  const words = toks.map((w, i) => ({ text: w, startMs: at + i * 300, endMs: at + i * 300 + 250, speaker: over.label ?? '0' }));
  const end = words[words.length - 1]?.endMs ?? at;
  return { utteranceId: over.utteranceId ?? `u-${text}`, text, final: over.final ?? true, words, startMs: at, endMs: end,
    heardToMs: over.heardToMs ?? end + 80, ...(over.event ? { event: over.event } : {}) };
}
