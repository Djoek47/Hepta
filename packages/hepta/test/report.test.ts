import { describe, expect, it } from 'vitest';
import { speculationReport, formatSpeculation, type Trace } from '../src/replay.js';

const trace = (act: string | null, last: { leader: string | null; status: string | null }): Trace => ({
  case: { text: 'x', act }, words: 1, switches: 0, leadWords: null, leadMs: null, peakTracks: 1,
  endedRight: last.leader === act, earlyCommit: false, wrongHold: last.status === 'hold' && last.leader !== act,
  ticks: [{ partial: { text: 'x', final: true, atMs: 0 } as never, leader: last.leader, switched: false, tracks: 1, status: last.status }],
});

describe('the replay report', () => {
  it('counts a hold on an act nobody asked for, which EARLY COMMITS cannot see', () => {
    const r = speculationReport([
      trace(null, { leader: 'assign_chore', status: 'hold' }),        // "did Sam do the laundry", before the fix
      trace('assign_chore', { leader: 'assign_chore', status: 'hold' }), // right act: fine
      trace(null, { leader: 'assign_chore', status: 'resolving' }),   // wrong, but asking, not holding
    ]);
    expect(r.wrongHolds).toBe(1);
    expect(r.earlyCommits).toBe(0);
    expect(formatSpeculation(r)).toMatch(/WRONG HOLDS {8}1/);
  });
});
