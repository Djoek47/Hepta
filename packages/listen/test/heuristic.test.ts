import { describe, expect, it } from 'vitest';
import { HeuristicDetector } from '../src/heuristic.js';
import type { ClaimView, QuestionView } from '../src/types.js';
import { heard, state } from './helpers.js';

const det = new HeuristicDetector();
const speakers = [
  { id: 'S1', name: 'Moderator', role: 'moderator' as const },
  { id: 'S2', name: 'Minister', role: 'panelist' as const },
  { id: 'S3', name: 'Shadow minister', role: 'panelist' as const },
];
const q1: QuestionView = { id: 'q1', by: 'S3', to: 'S2', text: 'How is it funded?', keys: ['fund'], topic: 'housing', askedMs: 0, asks: 1,
  turnsSince: 0, status: 'open', utteranceId: 'u0' };

describe('what is not the conversation', () => {
  it('ignores applause, ads, and nods', () => {
    expect(det.detect(heard('[applause]', { event: 'applause' }), state()).ignore).toBe('crowd');
    expect(det.detect(heard('This programme is brought to you by Halden Insurance.'), state()).ignore).toBe('ad');
    expect(det.detect(heard('Mm.'), state()).ignore).toBe('backchannel');
    expect(det.detect(heard('Yeah, right.'), state()).ignore).toBe('backchannel');
  });
  it('does not take a sentence for a nod', () => {
    expect(det.detect(heard('Yes, it should, but only if the cost is capped.'), state()).ignore).toBeUndefined();
  });
});

describe('subjects and shifts', () => {
  it('names the subject from its words', () => {
    expect(det.detect(heard('Our plan builds 40,000 homes by 2028, fully funded.'), state()).topic).toBe('housing');
  });
  it('calls a moderator moving on a natural transition', () => {
    const j = det.detect(heard("Let's leave it there and turn to immigration.", { speaker: 'S1' }),
      state({ speakers, current: { topic: 'housing', keys: ['housing', 'hom'], speaker: 'S2' } }));
    expect(j.topic).toBe('immigration');
    expect(j.shiftType).toBe('natural');
  });
});

describe('diversions', () => {
  const st = () => state({ speakers, questions: [{ ...q1 }], current: { topic: 'housing', keys: ['housing', 'hom', 'fund'], speaker: 'S3' } });
  it('reads a change of subject under an open question as a diversion', () => {
    const j = det.detect(heard('What I can tell you is that crime is up under your government.', { speaker: 'S2' }), st());
    expect(j.shiftType).toBe('diversion');
    expect(['deflection', 'whataboutism']).toContain(j.diversion?.type);
  });
  it('reads an answer as an answer, however it opens', () => {
    const j = det.detect(heard('What I can tell you is that it will be paid for by closing the non-dom loophole.', { speaker: 'S2' }), st());
    expect(j.answers).toBe('q1');
    expect(j.diversion).toBeUndefined();
  });
  it('reads an attack on the person', () => {
    expect(det.detect(heard('Record investment, from a man who has never built a shed, let alone a house.', { speaker: 'S3' }),
      state({ speakers })).diversion?.type).toBe('ad_hominem');
  });
});

describe('questions', () => {
  it('finds who a question is put to by name, longest name first', () => {
    const j = det.detect(heard('Shadow minister, will your party cut net migration?', { speaker: 'S1' }), state({ speakers }));
    expect(j.question?.to).toBe('S3');
    const k = det.detect(heard('Minister, where does the money come from?', { speaker: 'S1' }), state({ speakers }));
    expect(k.question?.to).toBe('S2');
  });
  it('recognises the same question asked again', () => {
    const j = det.detect(heard('Minister, the question was about funding.', { speaker: 'S1' }), state({ speakers, questions: [{ ...q1 }] }));
    expect(j.question?.repeatOf).toBe('q1');
  });
});

describe('claims', () => {
  const growth: ClaimView = { id: 'c1', speaker: 'S2', subject: 'growth', keys: ['growth'], value: 3, unit: '%', kind: 'fact',
    text: 'Growth this year is 3 percent.', atMs: 0, utteranceId: 'u0', status: 'standing' };
  it('extracts subject, value and unit', () => {
    const j = det.detect(heard('Unemployment is at 3 percent, a record low.'), state());
    expect(j.claim).toMatchObject({ subject: 'unemployment', value: 3, unit: '%', kind: 'fact' });
  });
  it('flags the same speaker changing a number, and leaves another speaker alone', () => {
    const mine = det.detect(heard('Growth is running at 5 percent, as I said.', { speaker: 'S2' }), state({ claims: [growth] }));
    expect(mine.claim?.contradicts).toMatchObject({ claimId: 'c1', kind: 'changed_claim' });
    expect(mine.diversion?.type).toBe('changed_claim');
    const theirs = det.detect(heard('Growth is running at 5 percent.', { speaker: 'S3' }), state({ claims: [growth] }));
    expect(theirs.claim?.contradicts).toBeUndefined();
  });
  it('checks a claim against the evidence pack', () => {
    const j = det.detect(heard('Unemployment is at 3 percent, a record low.'), state({
      evidence: [{ id: 'e1', subject: 'unemployment', keys: ['unemployment'], value: 4.1, unit: '%', text: 'Unemployment 4.1%' }],
    }));
    expect(j.claim?.contradicts).toEqual({ evidenceId: 'e1', kind: 'evidence' });
  });
  it('does not take a figure someone else said for a claim', () => {
    expect(det.detect(heard('Chancellor, a moment ago you said growth was 3 percent.'), state()).claim).toBeUndefined();
  });
  it('waits for a number said in words to finish', () => {
    expect(det.detect(heard('the savings goal is going to be five', { final: false, boundary: false }), state()).claim).toBeUndefined();
  });
});
