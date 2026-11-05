import { describe, expect, it } from 'vitest';

import { classify } from '@intermenu/aiuic-core';
import { LocalResolver, arbitrateSpans } from '../src/local.js';
import { OnDeviceResolver } from '../src/ondevice.js';
import { pickAct } from '../src/route.js';
import { JevResolver, optionKey, routingQuestion, slotQuestion, type JevTransport } from '../src/jev.js';
import { TieredResolver } from '../src/tiered.js';
import { matchPhrase, normalize, similarity, tokenize } from '../src/text.js';
import {
  CHORES,
  DRAKO,
  MAYA,
  PEOPLE,
  SEGMENTS,
  assignChore,
  ctx,
  massDm,
  optionsFor,
  resubDiscount,
} from './fixtures.js';

const local = new LocalResolver();

describe('text matching', () => {
  it('strips diacritics and punctuation', () => {
    expect(normalize('Amélie, où?')).toBe('amelie ou');
  });

  it('scores an STT name error high enough to survive', () => {
    expect(similarity('drako', 'draco')).toBeCloseTo(0.8, 2);
    expect(similarity('drako', 'maya')).toBeLessThan(0.3);
  });

  it('requires multi-token phrases to match in order', () => {
    const t = tokenize('take out the bins tonight');
    expect(matchPhrase(t, 'take out the bins')?.score).toBe(1);
    expect(matchPhrase(t, 'bins out take the')?.score ?? 0).toBeLessThan(1);
  });

  it('returns spans into the original text', () => {
    const t = tokenize('dishes for Drako tomorrow');
    expect(matchPhrase(t, 'Drako')?.span).toEqual([11, 16]);
  });
});

describe('local slot filling', () => {
  it('fills two slots from one utterance, offline', () => {
    const out = local.fillSync('dishes for Drako tomorrow', assignChore, {}, ctx(), optionsFor);
    expect(out.assignee?.[0]?.value).toBe(DRAKO);
    expect(out.assignee?.[0]?.score).toBe(1);
    expect(out.chore?.[0]?.value).toBe('dishes');
  });

  it('survives a transcription error on a name', () => {
    const out = local.fillSync('dishes for Draco', assignChore, {}, ctx(), optionsFor);
    expect(out.assignee?.[0]?.value).toBe(DRAKO);
    expect(out.assignee?.[0]?.score).toBeCloseTo(0.8, 2);
    // Below tau_fill, so the engine will treat it as provisional, not certain.
    expect(out.assignee?.[0]?.score).toBeLessThan(0.85);
  });

  it('skips model-only slots', () => {
    const out = local.fillSync('mass dm the expiring subs', massDm, {}, ctx(), optionsFor);
    expect(out.message).toBeUndefined();
    expect(out.audience?.[0]?.score).toBe(1);
  });

  it('gives the longer span the contested words', () => {
    const out = local.fillSync("Maya's room for Sam", assignChore, {}, ctx(), optionsFor);
    expect(out.chore?.[0]?.value).toBe('maya_room');
    expect(out.assignee?.map((c) => c.value)).not.toContain(MAYA);
    expect(out.assignee?.[0]?.value).toEqual({ id: 'u_sam', name: 'Sam' });
  });

  it('arbitrates overlapping spans in favour of the longer claim', () => {
    const merged = arbitrateSpans({
      a: [{ value: 'short', score: 1, span: [0, 4] }],
      b: [{ value: 'long', score: 1, span: [0, 9] }],
    });
    expect(merged.a).toBeUndefined();
    expect(merged.b).toHaveLength(1);
  });
});

describe('act routing', () => {
  const acts = [assignChore, massDm, resubDiscount];

  it('starts the named act when the phrase is explicit', () => {
    const scores = local.scoreSync(
      'mass dm the expiring subs at twelve dollars',
      acts,
      ctx(),
      optionsFor,
    );
    const d = pickAct(scores);
    expect(d.kind).toBe('start');
    expect(d.kind === 'start' && d.act).toBe('mass_dm_ppv');
  });

  it('narrows rather than guessing when two acts tie', () => {
    const scores = local.scoreSync('expiring subs at twelve', acts, ctx(), optionsFor);
    const d = pickAct(scores);
    expect(d.kind).toBe('narrow');
    expect(d.kind === 'narrow' && d.acts.sort()).toEqual(['mass_dm_ppv', 'resub_discount']);
  });

  it('starts nothing when no act is plausible', () => {
    const d = pickAct(local.scoreSync('what is the weather', acts, ctx(), optionsFor));
    expect(d.kind).toBe('none');
  });
});

describe('Jev adapter', () => {
  it('turns routing into a single Choice question', () => {
    const q = routingQuestion([massDm, resubDiscount]);
    expect(q.type).toBe('choice');
    expect(Object.keys(q.criteria).sort()).toEqual(['mass_dm_ppv', 'resub_discount']);
  });

  it('makes wire-safe keys and maps them back to host values', () => {
    const built = slotQuestion(assignChore, 'chore', CHORES);
    expect(built).not.toBeNull();
    expect(Object.keys(built!.question.criteria)).toContain('maya_s_room');
    expect(built!.back.get('dishes')).toBe('dishes');
    expect(optionKey({ value: 1, label: "Maya's room" }, 0)).toBe('maya_s_room');
  });

  it('never asks Jev for a quantity, a date, or free text', async () => {
    const seen: string[] = [];
    const transport: JevTransport = async (req) => {
      seen.push(...req.questions.map((q) => q.key));
      return { answers: [] };
    };
    await new JevResolver({ transport }).fill('blast the expiring subs', massDm, {}, ctx(), optionsFor);
    expect(seen).toEqual(['mass_dm_ppv.audience']);
  });

  it('maps a probability distribution straight onto candidates', async () => {
    const transport: JevTransport = async () => ({
      answers: [
        {
          key: 'assign_chore.assignee',
          choice: 'drako',
          confidence: 0.91,
          probabilities: { drako: 0.91, maya: 0.06, sam: 0.03 },
        },
      ],
    });
    const out = await new JevResolver({ transport }).fill(
      'dishes for Draco',
      assignChore,
      {},
      ctx(),
      optionsFor,
    );
    expect(out.assignee?.[0]?.value).toBe(DRAKO);
    expect(out.assignee?.[0]?.score).toBe(0.91);
    expect(out.assignee).toHaveLength(3);
  });
});

describe('tiering', () => {
  const jevSaysMaya: JevTransport = async () => ({
    answers: [
      {
        key: 'assign_chore.assignee',
        choice: 'maya',
        probabilities: { maya: 0.94, drako: 0.05, sam: 0.01 },
      },
    ],
  });

  it('refuses a non-local tier 0', () => {
    expect(
      () => new TieredResolver(local, [new JevResolver({ transport: jevSaysMaya }), local as never]),
    ).toThrow(/claims to be local/);
  });

  it('paints the local answer before any network call', () => {
    const tiered = new TieredResolver(local, [new JevResolver({ transport: jevSaysMaya })]);
    const staged = tiered.fill('dishes for Draco', assignChore, {}, ctx(), optionsFor);
    // Synchronous: no await happened.
    expect(staged.local.assignee?.[0]?.value).toBe(DRAKO);
  });

  it('lets a confident tier 1 correct a weak local match', async () => {
    const tiered = new TieredResolver(local, [new JevResolver({ transport: jevSaysMaya })]);
    const staged = tiered.fill('dishes for Draco', assignChore, {}, ctx(), optionsFor);
    const refined = await staged.refine;
    expect(refined.assignee?.[0]?.value).toBe(MAYA);
    expect(await staged.answered).toEqual(['jev']);
  });

  it('does not call tier 1 when the local match is certain', async () => {
    let calls = 0;
    const counting: JevTransport = async () => {
      calls++;
      return { answers: [] };
    };
    const tiered = new TieredResolver(local, [new JevResolver({ transport: counting })]);
    const staged = tiered.fill('dishes for Drako', assignChore, {}, ctx(), optionsFor);
    await staged.refine;
    expect(calls).toBe(0);
  });

  it('keeps working when tier 1 is unreachable', async () => {
    const dead: JevTransport = async () => {
      throw new Error('ENOTFOUND api.typesafe.ai');
    };
    const tiered = new TieredResolver(local, [new JevResolver({ transport: dead })]);
    const staged = tiered.fill('dishes for Drako', assignChore, {}, ctx(), optionsFor);
    const refined = await staged.refine;
    expect(refined.assignee?.[0]?.value).toBe(DRAKO);
    expect(await staged.answered).toEqual([]);
  });

  it('names the slots no tier can fill without an LLM', () => {
    const tiered = new TieredResolver(local, []);
    expect(tiered.modelOnlySlots(massDm)).toEqual(['message']);
    expect(tiered.modelOnlySlots(assignChore)).toEqual([]);
  });
});

describe('calibration', () => {
  it('an on-device scorer fills the slot but can never confirm it', async () => {
    const { OnDeviceResolver } = await import('../src/ondevice.js');
    const { classify } = await import('@intermenu/aiuic-core');

    const semif = new OnDeviceResolver({
      name: 'semif',
      scorer: async ({ options }) => options.map((o) => (o === 'Drako' ? 0.96 : 0.02)),
    });
    expect(semif.local).toBe(true);
    expect(semif.calibrated).toBe(false);

    const out = await semif.fill('dishes for Draco', assignChore, {}, ctx(), optionsFor);
    const best = out.assignee?.[0];
    expect(best?.value).toBe(DRAKO);
    expect(best?.score).toBe(0.96);

    // 0.96 clears tau_fill, but the score is not calibrated, so the core
    // refuses to treat it as confirmed.
    const c = classify(out.assignee!);
    expect(c.outcome).toBe('filled');
    expect(c.provisional).toBe(true);
  });

  it('a calibrated tier at the same score does confirm', async () => {
    const { classify } = await import('@intermenu/aiuic-core');
    const c = classify([
      { value: DRAKO, score: 0.96 },
      { value: MAYA, score: 0.02 },
    ]);
    expect(c.provisional).toBe(false);
  });

  it('keeps working offline: the on-device tier needs no network', async () => {
    const { OnDeviceResolver } = await import('../src/ondevice.js');
    const semif = new OnDeviceResolver({ scorer: async () => [] });
    expect(semif.local).toBe(true);
    const tiered = new TieredResolver(local, []);
    expect(tiered.local.calibrated).toBe(true);
    expect(semif.calibrated).toBe(false);
  });
});

describe('calibration', () => {
  // SemIf's own docs: the direct readout is "a softmax over only the displayed
  // option tokens. They are not calibrated confidence."
  const semif = new OnDeviceResolver({
    name: 'semif',
    scorer: async ({ options }) => options.map((o) => (o === 'Drako' ? 0.96 : 0.02)),
  });

  it('sits at tier 0 because it is offline, and admits it is uncalibrated', () => {
    expect(semif.local).toBe(true);
    expect(semif.calibrated).toBe(false);
    expect(local.calibrated).toBe(true);
  });

  it('fills the slot so the stage paints, but can never confirm it', async () => {
    const out = await semif.fill('dishes for Draco', assignChore, {}, ctx(), optionsFor);
    const best = out.assignee?.[0];
    expect(best?.value).toBe(DRAKO);
    expect(best?.score).toBe(0.96);

    // 0.96 clears tau_fill by a mile, and it still cannot confirm.
    const c = classify(out.assignee!);
    expect(c.outcome).toBe('filled');
    expect(c.provisional).toBe(true);
  });

  it('confirms at the same score when the producer is calibrated', () => {
    const c = classify([
      { value: DRAKO, score: 0.96 },
      { value: MAYA, score: 0.02 },
    ]);
    expect(c.provisional).toBe(false);
  });

  it('never asks the on-device tier for a quantity or a date', async () => {
    const asked: string[] = [];
    const spy = new OnDeviceResolver({
      scorer: async ({ question, options }) => {
        asked.push(question);
        return options.map(() => 0.5);
      },
    });
    await spy.fill('blast the expiring subs at twelve dollars', massDm, {}, ctx(), optionsFor);
    expect(asked).toEqual(['Which "audience" does the user mean?']);
  });
});
