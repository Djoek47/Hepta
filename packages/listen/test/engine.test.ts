import { describe, expect, it } from 'vitest';
import { Listener } from '../src/engine.js';
import { HeuristicDetector } from '../src/heuristic.js';
import { atBoundary } from '../src/boundary.js';
import { chunk } from './helpers.js';

describe('the listener', () => {
  it('numbers speakers in the order they speak, by the majority of their words', async () => {
    const l = new Listener({ mode: 'panel', detector: new HeuristicDetector() });
    const c = chunk('Good evening and welcome', { label: '7' });
    c.words[0]!.speaker = '3'; // the diarizer's first word went to the wrong label
    const d = await l.hear(c);
    expect(d.speaker).toBe('S1');
    expect(l.speakers.labelOf('S1')).toBe('7');
  });

  it('decides chunks in order, whatever the detector latency', async () => {
    const slow = { name: 'slow', local: true, detect: async (h: { text: string }) => {
      await new Promise((r) => setTimeout(r, h.text.length % 3 === 0 ? 15 : 1));
      return new HeuristicDetector().detect(h as never, { mode: 'panel', nowMs: 0, speakers: [], turns: [], current: { topic: null, keys: [], speaker: null }, threads: [], questions: [], claims: [], evidence: [] });
    } };
    const l = new Listener({ mode: 'panel', detector: slow });
    const texts = ['How', 'How is', 'How is it funded?'];
    const out = await Promise.all(texts.map((t, i) => l.hear(chunk(t, { final: i === 2, utteranceId: 'u1' }))));
    expect(out.map((d) => d.text)).toEqual(texts);
  });

  it('answers when addressed once the turn has ended, and not before', async () => {
    const l = new Listener({ mode: 'panel', detector: new HeuristicDetector() });
    const partial = await l.hear(chunk('Hepta, anything to', { final: false, utteranceId: 'u9' }));
    const final = await l.hear(chunk('Hepta, anything to flag?', { utteranceId: 'u9' }));
    expect(partial.respondState).toBe('ready');
    expect(final.respondState).toBe('ready');
    expect(await l.tick(final.atMs)).toBeNull(); // not quiet long enough yet
    const fired = await l.tick(final.atMs + 1000);
    expect(fired).toMatchObject({ respondState: 'respond', trigger: 'turn-end', utteranceId: 'u9' });
    await new Promise((r) => setTimeout(r, 0));
    expect(l.responses[0]).toMatchObject({ status: 'done', reason: 'cue', responder: 'template' });
  });
});

describe('clause boundaries', () => {
  it('sees punctuation, joint words and pauses, and nothing else', () => {
    expect(atBoundary(chunk('the budget is 600,', { final: false }))).toBe(true);
    expect(atBoundary(chunk('the budget is 600 and', { final: false }))).toBe(true);
    expect(atBoundary(chunk('the budget is 600 for', { final: false }))).toBe(false);
    const paused = chunk('the budget is 600 for the month', { final: false });
    paused.heardToMs = paused.words[paused.words.length - 1]!.endMs + 500;
    expect(atBoundary(paused)).toBe(true);
  });
});
