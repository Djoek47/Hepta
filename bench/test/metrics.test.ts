import { describe, expect, it } from 'vitest';
import type { JevDecision } from '@hepta/listen';
import type { Clip } from '../src/clip.js';
import { score } from '../src/metrics.js';
import type { ClipRun } from '../src/run.js';

const clip: Clip = {
  id: 'tiny', title: 'tiny', mode: 'panel', speakers: { MOD: { name: 'Moderator', role: 'moderator' }, A: { name: 'A', role: 'panelist' } },
  turns: [
    { id: 't1', speaker: 'A', text: 'Growth is 3 percent and that is good.' },
    { id: 't2', speaker: 'MOD', text: 'Hepta, anything?', addressed: true, hepta: 'respond', meta: true },
  ],
};

function d(over: Partial<JevDecision>): JevDecision {
  return { id: 'd', heardId: 'h', utteranceId: 'u1', final: false, speaker: 'S1', text: '', atMs: 0, topic: null, shiftType: 'none',
    addressedToHepta: false, respondState: 'listen', confidence: 0.5, latencyMs: 1, detectorMs: 1, backend: 'x', provisional: true,
    boundary: false, readings: [], ...over };
}

function run(steps: { d: JevDecision; turnId: string }[]): ClipRun {
  return {
    clip, backend: 'x', wallMs: 0, truthOf: { S1: 'A', S2: 'MOD' }, listener: undefined as never,
    sim: { chunks: [], labels: { 0: 'A', 1: 'MOD' }, utteranceTurn: {}, turnTimes: {}, durationMs: 0 },
    steps: steps.map((s) => ({ d: s.d, sc: { chunk: { utteranceId: s.d.utteranceId, text: s.d.text, final: s.d.final, words: [], startMs: 0, endMs: 0, heardToMs: 0 }, turnId: s.turnId, truthSpeaker: 'A', truth: [] } })),
  };
}

describe('scoring when Hepta took the floor', () => {
  it('counts a response mid-clause as a wrong interruption, whatever the labels say', () => {
    const m = score(run([{ d: d({ text: 'Growth is 3', respondState: 'respond' }), turnId: 't1' }]));
    expect(m.respond.wrongInterruptions).toBe(1);
  });
  it('counts a response at the end of the cue as on time, and one in a quiet turn as out of turn', () => {
    const m = score(run([
      { d: d({ text: 'Growth is 3 percent and', boundary: true, respondState: 'respond' }), turnId: 't1' },
      { d: d({ utteranceId: 'u2', speaker: 'S2', text: 'Hepta, anything?', final: true, boundary: true, addressedToHepta: true, respondState: 'respond' }), turnId: 't2' },
    ]));
    expect(m.respond).toMatchObject({ wrongInterruptions: 0, outOfTurn: 1, hit: 1, expected: 1, missed: 0 });
  });
});
