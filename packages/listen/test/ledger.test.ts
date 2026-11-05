import { describe, expect, it } from 'vitest';
import { Listener } from '../src/engine.js';
import { HeuristicDetector, answerScore } from '../src/heuristic.js';
import type { QuestionView } from '../src/types.js';
import { chunk } from './helpers.js';

/** A little panel: S1 moderator, S2 minister, S3 shadow minister — named as an operator would. */
function panel(dodgeTurns = 2) {
  const l = new Listener({ mode: 'panel', detector: new HeuristicDetector(), dodgeTurns });
  let t = 0;
  const say = async (label: string, text: string) => {
    const c = chunk(text, { label, at: t, utteranceId: `u${t}` });
    t = c.endMs + 900;
    if (!l.speakers.get(l.speakers.idFor(label))?.name) {
      const names: Record<string, [string, 'moderator' | 'panelist']> = { m: ['Moderator', 'moderator'], a: ['Minister', 'panelist'], b: ['Shadow minister', 'panelist'] };
      const [n, r] = names[label]!;
      l.name(l.speakers.idFor(label), n, r);
    }
    return l.hear(c);
  };
  return { l, say };
}

const q = (text: string): QuestionView => ({ id: 'q', by: 'S1', to: 'S2', text, keys: [], topic: null, askedMs: 0, asks: 1, turnsSince: 0, status: 'open', utteranceId: 'u' });

describe('questions dodged', () => {
  it('calls a question dodged when the person asked takes two turns without answering it', async () => {
    const { l, say } = panel();
    await say('m', 'Housing first.');
    await say('a', 'Our plan builds 40,000 homes by 2028, fully funded.');
    await say('b', 'How is it funded? You have not said.');
    await say('a', 'What I can tell you is that crime is up under your government.');
    await say('b', 'That is not what I asked.');
    const before = await say('a', 'We have committed record investment and we are getting on with the job.');
    expect(before.dodged).toBeUndefined(); // the turn is not over until someone else speaks
    const after = await say('m', 'Let us leave it there.');
    expect(after.dodged).toHaveLength(1);
    const card = l.insights.find((i) => i.kind === 'dodged')!;
    expect(card.text).toMatch(/^“How is it funded\?” asked by S3 at \d\d:\d\d, not answered\.$/);
  });

  it('does not count a nod as a turn, nor a question answered', async () => {
    const { l, say } = panel();
    await say('m', 'Minister, will you raise income tax?');
    await say('a', 'Mm.');
    await say('m', 'Minister?');
    await say('a', 'We have no plans to raise income tax.');
    await say('b', 'No plans is not a no.');
    expect(l.memory.questions[0]).toMatchObject({ status: 'answered', answeredBy: 'S2' });
    expect(l.decisions.some((d) => d.dodged?.length)).toBe(false);
  });

  it('keeps the count when the question is asked again, and says it was asked again', async () => {
    const { l, say } = panel();
    await say('m', 'Minister, are you on track to halve waiting lists?');
    await say('a', 'Our commitment is clear.');
    await say('m', 'So are you on track, minister, yes or no?');
    await say('a', 'What matters is that waiting lists are no longer rising as fast as they were.');
    await say('b', 'That is moving the goalposts.');
    expect(l.memory.questions).toHaveLength(1);
    expect(l.memory.questions[0]).toMatchObject({ asks: 2, status: 'dodged', to: 'S2' });
    expect(l.insights.map((i) => i.kind)).toEqual(expect.arrayContaining(['repeat', 'dodged']));
  });

  it('binds a question put to a name before that person has spoken', async () => {
    const { l, say } = panel();
    await say('m', 'Minister, are you on track?');
    expect(l.memory.questions[0]!.to).toBeNull();
    await say('a', 'We are on track.');
    expect(l.memory.questions[0]).toMatchObject({ to: 'S2', status: 'answered' });
  });
});

describe('what counts as an answer', () => {
  it('wants yes, no, or the question’s own verb back', () => {
    expect(answerScore('We are on track, yes.', q('Minister, are you on track to halve waiting lists?'))).toBeGreaterThanOrEqual(0.5);
    expect(answerScore('We will halve waiting lists by 2027.', q('Minister, are you on track to halve waiting lists?'))).toBeLessThan(0.5);
    expect(answerScore('We have no plans to raise income tax.', q('Chancellor, will you raise income tax?'))).toBeGreaterThanOrEqual(0.5);
    expect(answerScore('Waiting lists are no longer rising.', q('So are you on track, minister, yes or no?'))).toBeLessThan(0.5);
  });
  it('wants a source for "how will you pay", and an option for "which is it"', () => {
    expect(answerScore('It will be paid for by closing the loophole.', q('How will you pay for free school meals?'))).toBeGreaterThan(0.5);
    expect(answerScore('Crime is up under your government.', q('How is it funded?'))).toBeLessThan(0.5);
    expect(answerScore('The economy is stronger than when we took office.', q('So which is it, Chancellor, three or five?'))).toBeLessThan(0.5);
  });
  it('takes the next turn of the person asked as the answer to an open question, unless it attacks', () => {
    const open = q('Parent, what would you change first?');
    expect(answerScore('More teachers and smaller classes.', open, { adjacent: true, onTopic: true })).toBeGreaterThanOrEqual(0.5);
    expect(answerScore('Under your government, school meals were cut in half.', open, { adjacent: true, onTopic: true })).toBeLessThan(0.5);
  });
});

describe('claims on record', () => {
  it('keeps a contradiction beside the claim it contradicts, never over it', async () => {
    const { l, say } = panel();
    await say('a', 'Growth this year is 3 percent.');
    const d = await say('a', 'Growth is running at 5 percent.');
    expect(d.diversion?.type).toBe('changed_claim');
    expect(d.diversion?.quotes.map((x) => x.text)).toEqual(['Growth this year is 3 percent.', 'Growth is running at 5 percent.']);
    expect(l.memory.claims.map((c) => [c.value, c.status])).toEqual([[3, 'standing'], [5, 'contradicts']]);
    expect(l.insights.find((i) => i.kind === 'contradiction')!.text).toMatch(/^S1 said 3% at \d\d:\d\d, now says 5%\.$/);
  });

  it('settles it when the speaker corrects themselves out loud, without calling it a changed story', async () => {
    const { l, say } = panel();
    await say('a', 'Growth this year is 3 percent.');
    const d = await say('a', 'Sorry, I meant growth is 5 percent.');
    expect(d.diversion).toBeUndefined();
    expect(l.memory.claims.map((c) => [c.value, c.status])).toEqual([[3, 'superseded'], [5, 'standing']]);
    expect(l.insights.map((i) => i.kind)).toContain('correction');
  });

  it('lets a small revision update the claim, and the last word in one breath stand', async () => {
    const { l, say } = panel();
    await say('b', 'Pensions would rise by 4 percent.');
    await say('b', 'To be precise, pensions would rise by 4.1 percent.');
    expect(l.memory.claims.map((c) => [c.value, c.status])).toEqual([[4, 'superseded'], [4.1, 'standing']]);
    await say('a', 'My grocery budget is 400.');
    const d = await say('a', 'The grocery budget is 650, no sorry, 400 like we said.');
    expect(d.claim?.contradicts).toBeUndefined();
  });

  it('checks a figure against the evidence pack and says what the pack says', async () => {
    const l = new Listener({ mode: 'panel', detector: new HeuristicDetector(), evidence: [{ id: 'e1', subject: 'unemployment', keys: ['unemployment'], value: 4.1, unit: '%', text: 'Unemployment rate 4.1%', source: 'ONS, Sept 2026' }] });
    await l.hear(chunk('Unemployment is at 3 percent, a record low.'));
    const card = l.insights.find((i) => i.kind === 'evidence')!;
    expect(card.text).toBe('S1 said 3% on unemployment; the evidence pack says Unemployment rate 4.1%.');
    expect(card.detail).toBe('Source: ONS, Sept 2026');
  });
});
