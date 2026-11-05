import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Clip } from '../src/clip.js';
import { simulate } from '../src/simulate.js';

const clip = JSON.parse(readFileSync(new URL('../clips/01-panel-housing.json', import.meta.url), 'utf8')) as Clip;

describe('the simulated recognizer', () => {
  it('is repeatable for a seed', () => {
    expect(JSON.stringify(simulate(clip, { seed: 3 }).chunks)).toBe(JSON.stringify(simulate(clip, { seed: 3 }).chunks));
  });

  it('delivers growing partials and one final per sentence, in time order', () => {
    const sim = simulate(clip, { seed: 1 });
    const finals = sim.chunks.filter((c) => c.chunk.final);
    const sentences = clip.turns.reduce((n, t) => n + t.text.split(/(?<=[.?!])\s+/).filter((s) => s.trim()).length, 0);
    expect(finals).toHaveLength(sentences);
    const times = sim.chunks.map((c) => c.chunk.heardToMs);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('labels speakers in order of appearance, and mislabels the first words of some turns', () => {
    const clean = simulate(clip, { seed: 1, onsetLag: 0, flicker: 0 });
    const words = clean.chunks.filter((c) => c.chunk.final).flatMap((c) => c.truth);
    expect(words.every((w) => clean.labels[w.speaker!] === w.truth)).toBe(true);
    expect(clean.labels['0']).toBe('MOD');
    const noisy = simulate(clip, { seed: 1, onsetLag: 1, flicker: 0 });
    const wrong = noisy.chunks.filter((c) => c.chunk.final).flatMap((c) => c.truth).filter((w) => noisy.labels[w.speaker!] !== w.truth);
    expect(wrong.length).toBeGreaterThan(5);
  });
});
