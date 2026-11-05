import { describe, expect, it } from 'vitest';
import type { JevAnswer, JevRequest, JevResponse, JevTransport } from '@intermenu/aiuic-resolve';
import { JevDetector } from '../src/jev.js';
import { heard, state } from './helpers.js';

function fake(answer: (req: JevRequest) => JevResponse | Promise<JevResponse>) {
  const seen: JevRequest[] = [];
  const t: JevTransport = async (req) => { seen.push(req); return answer(req); };
  return { t, seen };
}

describe('the Jev backend', () => {
  it('asks the short set on a partial and the full set on a final', async () => {
    const { t, seen } = fake(() => ({ answers: [] }));
    const det = new JevDetector({ transport: t });
    const st = state({
      questions: [{ id: 'q1', by: 'S3', to: 'S1', text: 'How is it funded?', keys: ['fund'], topic: 'housing', askedMs: 0, asks: 1, turnsSince: 0, status: 'open', utteranceId: 'u0' }],
      claims: [{ id: 'c1', speaker: 'S1', subject: 'homes', keys: ['hom'], value: 40000, kind: 'commitment', text: '40,000 homes by 2028', atMs: 0, utteranceId: 'u0', status: 'standing' }],
    });
    await det.detect(heard('What I can tell you', { final: false, boundary: false }), st);
    await det.detect(heard('What I can tell you is that crime is up.'), st);
    expect(seen[0]!.questions.map((q) => q.key)).toEqual(['shift', 'diversion', 'addressed', 'ignore']);
    expect(seen[1]!.questions.map((q) => q.key)).toEqual(['shift', 'diversion', 'addressed', 'ignore', 'answers', 'contradicts']);
  });

  it('takes the model judgment over the local one, and keeps two readings', async () => {
    const answers: JevAnswer[] = [
      { key: 'shift', choice: 'diversion', probabilities: { diversion: 0.7, follow_up: 0.2 }, confidence: 0.7 },
      { key: 'diversion', choice: 'deflection', probabilities: { deflection: 0.65, whataboutism: 0.25 }, confidence: 0.65 },
      { key: 'addressed', noul: 0.05 },
      { key: 'ignore', choice: 'conversation', probabilities: { conversation: 0.95 }, confidence: 0.95 },
    ];
    const { t } = fake(() => ({ answers }));
    const j = await new JevDetector({ transport: t }).detect(heard('What I can tell you is that crime', { final: false, boundary: false }), state());
    expect(j.shiftType).toBe('diversion');
    expect(j.diversion?.type).toBe('deflection');
    expect(j.readings.length).toBeGreaterThanOrEqual(2);
    expect(j.readings[0]!.label).toBe('diversion:deflection');
  });

  it('falls back to the local judgment when the answer is late', async () => {
    const t: JevTransport = () => new Promise((r) => setTimeout(() => r({ answers: [] }), 200));
    const det = new JevDetector({ transport: t, timeoutMs: 20 });
    const j = await det.detect(heard('Our plan builds 40,000 homes by 2028.'), state());
    expect(j.topic).toBe('housing');
    expect(det.stats.fellBack).toBe(1);
  });

  it('does not ask a model about applause', async () => {
    const { t, seen } = fake(() => ({ answers: [] }));
    const j = await new JevDetector({ transport: t }).detect(heard('[applause]', { event: 'applause' }), state());
    expect(j.ignore).toBe('crowd');
    expect(seen).toHaveLength(0);
  });
});
