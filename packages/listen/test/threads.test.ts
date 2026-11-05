import { describe, expect, it } from 'vitest';
import { HALF_LIFE_MS, Threads } from '../src/threads.js';
import { HeuristicDetector } from '../src/heuristic.js';
import { Memory } from '../src/memory.js';
import { heard, state } from './helpers.js';

describe('lines of thought', () => {
  it('halves a weight every five minutes and keeps the subject on air', () => {
    const t = new Threads();
    t.on('housing', ['hous'], 'Our plan builds 40,000 homes', 'S1', 0, 2000);
    expect(t.view(0)[0]).toMatchObject({ topic: 'housing', weight: 1, onAir: true });
    expect(t.view(HALF_LIFE_MS)[0]!.weight).toBeCloseTo(0.5, 2);
    expect(t.view(2 * HALF_LIFE_MS)[0]!.weight).toBeCloseTo(0.25, 2);
  });

  it('lifts a line when its words come up again, and moves the light to the subject now on air', () => {
    const t = new Threads();
    t.on('housing', [], 'how is the housing plan funded, the homes funding', 'S2', 0, 1000);
    t.on('crime', [], 'crime is up under your government', 'S1', 2000, 3000);
    t.on('crime', [], 'crime figures and the funding of homes', 'S1', 4000, 5000);
    const v = t.view(5000);
    expect(v.find((x) => x.topic === 'crime')!.onAir).toBe(true);
    expect(v.find((x) => x.topic === 'housing')!.onAir).toBe(false);
    expect(v.find((x) => x.topic === 'housing')!.mentions).toBe(1);
    expect(v.find((x) => x.topic === 'housing')!.weight).toBeGreaterThan(1.4);
  });

  it('remembers who opened a line', () => {
    const t = new Threads();
    t.on('housing', [], 'homes', 'S2', 0, 100);
    t.on('housing', [], 'homes again', 'S3', 200, 300);
    expect(t.view(300)[0]!.owner).toBe('S2');
  });
});

describe('subjects, with continuity', () => {
  const det = new HeuristicDetector();
  const speakers = [{ id: 'S1', name: 'Moderator', role: 'moderator' as const }, { id: 'S2', name: 'Minister', role: 'panelist' as const }, { id: 'S3', name: 'Panelist B', role: 'panelist' as const }];
  const on = (topic: string, keys: string[]) => state({ speakers, current: { topic, keys, speaker: 'S1' },
    threads: [{ id: 'th1', topic, keys, weight: 1, mentions: 0, owner: 'S1', openedMs: 0, lastMs: 0, onAir: true }] });

  it('carries the subject through sentences that name none', () => {
    expect(det.detect(heard('Opening against.'), on('net zero cost', ['net', 'zero', 'cost'])).topic).toBe('net zero cost');
    expect(det.detect(heard('Our commitment is clear.', { speaker: 'S2' }), on('health', ['health', 'wait'])).shiftType).toBe('none');
  });

  it('does not move on one weak word', () => {
    const j = det.detect(heard('We have committed record investment and we are getting on with the job.', { speaker: 'S2' }), on('housing', ['hous', 'hom', 'fund']));
    expect(j.topic).toBe('housing');
  });

  it('moves when the speaker says so, and calls it what it is', () => {
    const j = det.detect(heard("Let's move on to exams.", { speaker: 'S1' }), on('council tax', ['council', 'tax']));
    expect(j).toMatchObject({ topic: 'education', shiftType: 'natural' });
    const k = det.detect(heard('On council tax, most of my colleagues would pay a bit more.', { speaker: 'S2' }), on('education', ['teacher', 'class']));
    expect(k).toMatchObject({ topic: 'taxes', shiftType: 'follow_up' });
  });

  it('keeps a question within its subject unless it names one already open', () => {
    const st = on('transport', ['rail', 'line', 'cost']);
    expect(det.detect(heard('And what about the people who will lose their homes?', { speaker: 'S3' }), st).topic).toBe('transport');
    st.threads.push({ id: 'th2', topic: 'travel', keys: ['trip'], weight: 1, mentions: 0, owner: 'S1', openedMs: 0, lastMs: 0, onAir: false });
    expect(det.detect(heard('What about the trip?', { speaker: 'S3' }), st).topic).toBe('travel');
  });

  it('puts the person on air for an ad hominem, and returns to the subject after it', () => {
    const m = new Memory();
    const st0 = on('health', ['health', 'wait', 'list']);
    const attack = heard('The doctor would say that. His union has been on strike for months.', { speaker: 'S2' });
    const j = det.detect(attack, { ...st0, speakers: [...speakers, { id: 'S4', name: 'Doctor', role: 'panelist' }] });
    expect(j.about).toEqual({ kind: 'person', target: 'S4' });
    expect(j.shiftType).toBe('diversion');
    m.commit(heard('Waiting lists are up.', { speaker: 'S4' }), { ...det.detect(heard('Waiting lists are up.', { speaker: 'S4' }), st0) });
    m.commit(attack, j);
    expect(m.current.about?.target).toBe('S4');
    expect(m.current.resume?.topic).toBe('health');
    const back = det.detect(heard("Let's stay with patients.", { speaker: 'S1' }), m.snapshot('panel', speakers, 0, []));
    expect(back).toMatchObject({ topic: 'health', shiftType: 'follow_up' });
  });

  it('keeps an answer with its question', () => {
    const st = on('school meals', ['school', 'meal', 'pay']);
    st.questions = [{ id: 'q1', by: 'S1', to: 'S2', text: 'How will you pay for free school meals?', keys: ['pay', 'school', 'meal'], topic: 'school meals', askedMs: 0, asks: 1, turnsSince: 0, status: 'open', utteranceId: 'u0' }];
    const j = det.detect(heard('It will be paid for by closing the non-dom tax loophole.', { speaker: 'S2' }), st);
    expect(j).toMatchObject({ answers: 'q1', topic: 'school meals', shiftType: 'none' });
  });
});
