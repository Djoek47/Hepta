/**
 * Lines of thought. Each subject the conversation takes up is a thread with a
 * weight: it rises while the subject is on air and each time its words come
 * up again, and it halves every five minutes otherwise. Weights fade unless
 * the subject comes back — the panel shows what is still alive, not
 * everything ever said.
 */
import { contentStems, jaccard, keyOverlap } from './text.js';
import type { ThreadView } from './types.js';

export const HALF_LIFE_MS = 5 * 60_000;
export const ON_AIR_BUMP = 1;
export const MENTION_BUMP = 0.5;
export const MAX_WEIGHT = 5;

type ThreadState = ThreadView & { bag: Map<string, number>; at: number };

export class Threads {
  private readonly list: ThreadState[] = [];
  private seq = 0;

  constructor(private readonly halfLifeMs = HALF_LIFE_MS) {}

  private decay(now: number): void {
    for (const t of this.list) {
      const dt = now - t.at;
      if (dt > 0) {
        t.weight *= Math.pow(0.5, dt / this.halfLifeMs);
        t.at = now;
      }
    }
  }

  /** An utterance on `topic`: open its thread or feed it, and put it on air. */
  on(topic: string, seedKeys: string[], text: string, speaker: string, startMs: number, endMs: number): ThreadView {
    this.decay(startMs);
    let t = this.list.find((x) => x.topic === topic);
    if (!t) {
      t = { id: `th${++this.seq}`, topic, keys: [], weight: 0, mentions: 0, owner: speaker, openedMs: startMs, lastMs: endMs, onAir: true, bag: new Map(), at: startMs };
      this.list.push(t);
      for (const k of seedKeys) t.bag.set(k, (t.bag.get(k) ?? 0) + 1);
    }
    for (const s of contentStems(text)) t.bag.set(s, (t.bag.get(s) ?? 0) + 1);
    t.keys = top(t.bag);
    t.weight = Math.min(MAX_WEIGHT, t.weight + ON_AIR_BUMP);
    t.lastMs = endMs;
    for (const x of this.list) x.onAir = x === t;
    // The subject comes up in another line's words: that line is alive too.
    const stems = contentStems(text);
    for (const x of this.list) {
      if (x === t || x.keys.length === 0) continue;
      if (keyOverlap(text, x.keys.slice(0, 4)) >= 0.5 || jaccard(stems, x.keys.slice(0, 8)) >= 0.3) {
        x.weight = Math.min(MAX_WEIGHT, x.weight + MENTION_BUMP);
        x.mentions++;
      }
    }
    return { ...t, keys: [...t.keys] };
  }

  /** Nothing is on air (a cue to Hepta, a break). */
  offAir(): void {
    for (const x of this.list) x.onAir = false;
  }

  find(topic: string): ThreadView | undefined {
    const t = this.list.find((x) => x.topic === topic);
    return t ? { ...t, keys: [...t.keys] } : undefined;
  }

  /** Every thread, weights as of `now`, heaviest first. */
  view(now: number): ThreadView[] {
    this.decay(now);
    return this.list
      .map(({ bag: _b, at: _a, ...t }) => ({ ...t, keys: [...t.keys], weight: Math.round(t.weight * 1000) / 1000 }))
      .sort((a, b) => b.weight - a.weight);
  }
}

function top(bag: Map<string, number>, n = 24): string[] {
  return [...bag.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
}
