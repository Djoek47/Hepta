/**
 * Third-host validation: the Divine Mimic interview, ported from
 * Creatix @ cursor/marketing-overhaul-60a5 (5627521) as act definitions.
 *
 * This is a different SHAPE of host from the first two. Chores and campaigns
 * create records. This one builds a profile over many turns and finalizes once.
 * If the schema carries it too, the abstraction is not a task engine either.
 *
 * The rule under test is the one that currently lives in an English prompt:
 *
 *   "Do not call mimic_finalize_interview until all 4 steps above are covered."
 *
 * A model can ignore a sentence. It cannot ignore a required slot.
 */

import { describe, expect, it } from 'vitest';

import { createAIUIC } from '../src/engine.js';
import { FakeClock } from '../src/clock.js';
import { defineAct } from '../src/define.js';
import type { Ctx, Filled } from '../src/types.js';

const T0 = 1_700_000_000_000;
declare const setTimeout: (fn: () => void, ms: number) => unknown;
const tick = () => new Promise<void>((r) => setTimeout(() => r(), 0));

type Profile = {
  consentFanFacingDrafts?: boolean;
  neverSendWithoutReview?: boolean;
  toneWarmth?: number;
  flirtCeiling?: number;
  humorLevel?: number;
  humanizationLevel?: number;
  signaturePhrases?: string[];
  exemplarReplies?: string[];
  notes?: string;
  finalizedAt?: string;
};

const DIALS = [
  { value: 'toneWarmth', label: 'tone warmth' },
  { value: 'flirtCeiling', label: 'flirt ceiling' },
  { value: 'humorLevel', label: 'humor level' },
  { value: 'humanizationLevel', label: 'humanization level' },
];

function harness(initial: Profile = {}) {
  const profile: Profile = { neverSendWithoutReview: true, consentFanFacingDrafts: false, ...initial };
  const clock = new FakeClock(T0);
  const transcript: { q: string; a: string }[] = [];
  const drafted: string[] = [];

  const ui = createAIUIC({
    clock,
    ctx: () => ({
      actor: { id: 'creator_1' },
      attention: { foreground: true, unlocked: true, proximityClear: true, listening: true },
      reachLimit: 1,
      undoWindowMs: 5000,
    }),
  });

  // One interview turn. The creator's own words are the value, so this is a
  // LOCAL fill: a ghostField holding a transcript needs no model at all.
  ui.defineAct(
    defineAct({
      name: 'record_answer',
      slots: {
        question: { primitive: 'objectCard', options: () => [], required: true, order: 1 },
        answer: { primitive: 'ghostField', fill: 'local', options: () => [], required: true, order: 2 },
      },
      radius: 'self',
      commit: (f) => {
        transcript.push({ q: String(f.question), a: String(f.answer) });
        return { id: `t${transcript.length}`, previous: null };
      },
      undo: () => {
        transcript.pop();
      },
    }),
  );

  ui.defineAct(
    defineAct({
      name: 'set_dial',
      phrases: ['set', 'make it'],
      slots: {
        dial: { primitive: 'chip', options: () => DIALS, required: true, order: 1 },
        level: { primitive: 'quantity', params: { min: 0, max: 5 }, options: () => [], required: true, order: 2 },
      },
      radius: 'self',
      commit: (f) => {
        const key = f.dial as keyof Profile;
        const previous = profile[key];
        (profile as Record<string, unknown>)[key as string] = f.level;
        return { id: String(key), previous };
      },
      undo: (r) => {
        (profile as Record<string, unknown>)[r.id] = r.previous;
      },
    }),
  );

  /**
   * The consent toggle. In the original this is two loose booleans and a
   * sentence of intent. Here the blast radius is DERIVED from them: letting an
   * AI draft text that reaches fans with the review gate off is `external`, so
   * it can never silence-commit, whatever anyone types in a prompt.
   */
  ui.defineAct(
    defineAct({
      name: 'enable_fan_drafts',
      slots: {
        enabled: {
          primitive: 'chip',
          options: () => [
            { value: true, label: 'yes' },
            { value: false, label: 'no' },
          ],
          required: true,
          order: 1,
        },
      },
      radius: {
        max: 'external',
        of: (f: Filled) => {
          if (f.enabled !== true) return 'self';
          return profile.neverSendWithoutReview === false ? 'external' : 'shared';
        },
      },
      commit: (f) => {
        const previous = profile.consentFanFacingDrafts;
        profile.consentFanFacingDrafts = f.enabled as boolean;
        return { id: 'consent', previous };
      },
      undo: (r) => {
        profile.consentFanFacingDrafts = r.previous as boolean;
      },
      effects: [
        {
          name: 'draft_to_fans',
          when: () => profile.consentFanFacingDrafts === true && profile.neverSendWithoutReview === false,
          run: () => {
            drafted.push('sent');
          },
          radius: 'external',
          reversible: false,
          deferrable: false,
        },
      ],
    }),
  );

  /**
   * Finalize. Coverage is not a sentence in a prompt: each step is a required
   * slot whose default reads the profile. An uncovered step leaves its slot
   * empty, so the act cannot reach HOLD and the engine plays a beat for it.
   */
  ui.defineAct(
    defineAct({
      name: 'finalize_profile',
      slots: {
        policy: {
          primitive: 'peek',
          options: () => [],
          required: true,
          order: 1,
          default: () =>
            profile.neverSendWithoutReview !== undefined && profile.consentFanFacingDrafts !== undefined
              ? 'covered'
              : undefined,
        },
        style: {
          primitive: 'peek',
          options: () => [],
          required: true,
          order: 2,
          default: () =>
            profile.toneWarmth !== undefined && profile.humorLevel !== undefined ? 'covered' : undefined,
        },
        examples: {
          primitive: 'peek',
          options: () => [],
          required: true,
          order: 3,
          default: () => ((profile.exemplarReplies ?? []).length >= 1 ? 'covered' : undefined),
        },
        summary: {
          primitive: 'peek',
          options: () => [],
          required: true,
          order: 4,
          default: () => (transcript.length > 0 ? 'covered' : undefined),
        },
      },
      radius: 'self',
      commit: () => {
        const previous = profile.finalizedAt;
        profile.finalizedAt = new Date(T0).toISOString();
        return { id: 'profile', previous };
      },
      undo: (r) => {
        profile.finalizedAt = r.previous as string | undefined;
      },
    }),
  );

  return {
    ui,
    profile,
    transcript,
    drafted,
    async advance(ms: number) {
      clock.advance(ms);
      await tick();
    },
  };
}

describe('interview as acts', () => {
  it('records a turn with no model in the loop', async () => {
    const h = harness();
    const run = h.ui.start('record_answer');
    run.setValue('question', 'How warm should replies feel?', 'model');
    run.setValue('answer', 'Warm but not gushing.', 'spoken');

    expect(run.status).toBe('hold');
    await h.advance(900);
    expect(h.transcript).toEqual([{ q: 'How warm should replies feel?', a: 'Warm but not gushing.' }]);
  });

  it('refuses to finalize until every step is covered', () => {
    const h = harness();
    const run = h.ui.start('finalize_profile');

    // Policy has defaults, so step 1 is covered. The rest are not.
    expect(run.status).toBe('resolving');
    expect(run.state().focus).toBe('style');
    expect(h.profile.finalizedAt).toBeUndefined();
  });

  it('names the next uncovered step, in declared order, as each is filled', async () => {
    const h = harness();
    const dial = h.ui.start('set_dial');
    dial.setValue('dial', 'toneWarmth', 'spoken');
    dial.setValue('level', 4, 'spoken');
    await h.advance(900);

    const dial2 = h.ui.start('set_dial');
    dial2.setValue('dial', 'humorLevel', 'spoken');
    dial2.setValue('level', 2, 'spoken');
    await h.advance(900);

    // Style now covered; examples is next.
    expect(h.ui.start('finalize_profile').state().focus).toBe('examples');

    h.profile.exemplarReplies = ['hey you'];
    expect(h.ui.start('finalize_profile').state().focus).toBe('summary');

    const turn = h.ui.start('record_answer');
    turn.setValue('question', 'Anything you never say?', 'model');
    turn.setValue('answer', 'I never say babe.', 'spoken');
    await h.advance(900);

    // Every slot came from a default, so the creator did nothing inside THIS
    // act: the attention gate fails on engagement and silence cannot commit it.
    // Correct — a profile should not finalize itself because someone went quiet.
    const fin = h.ui.start('finalize_profile');
    expect(fin.status).toBe('explicit');
    expect(fin.state().gateFailures).toContain(
      'user has not touched or spoken during this act',
    );

    await h.advance(60_000);
    expect(h.profile.finalizedAt).toBeUndefined();

    await fin.assent();
    await tick();
    expect(h.profile.finalizedAt).toBeDefined();
  });

  it('keeps consent self-scoped when it is declined', () => {
    const h = harness();
    const run = h.ui.start('enable_fan_drafts');
    run.setValue('enabled', false, 'spoken');
    expect(run.radius).toBe('self');
    expect(run.status).toBe('hold');
  });

  it('is shared while the review gate holds, and silence may commit', async () => {
    const h = harness();
    const run = h.ui.start('enable_fan_drafts');
    run.setValue('enabled', true, 'spoken');
    expect(run.radius).toBe('shared');
    await h.advance(900);
    expect(h.profile.consentFanFacingDrafts).toBe(true);
    await h.advance(6000);
    expect(h.drafted).toHaveLength(0); // review gate still on
  });

  it('becomes external the moment the review gate is off, and silence cannot commit it', async () => {
    const h = harness({ neverSendWithoutReview: false });
    const run = h.ui.start('enable_fan_drafts');
    run.setValue('enabled', true, 'spoken');

    expect(run.radius).toBe('external');
    expect(run.status).toBe('explicit');

    await h.advance(60_000);
    expect(h.profile.consentFanFacingDrafts).toBe(false);
    expect(h.drafted).toHaveLength(0);

    await run.assent();
    await tick();
    expect(h.profile.consentFanFacingDrafts).toBe(true);
    expect(h.drafted).toEqual(['sent']);
  });

  it('undoes a dial back to its previous level, not to zero', async () => {
    const h = harness({ toneWarmth: 3 });
    const run = h.ui.start('set_dial');
    run.setValue('dial', 'toneWarmth', 'spoken');
    run.setValue('level', 5, 'spoken');
    await h.advance(900);
    expect(h.profile.toneWarmth).toBe(5);

    await run.undo();
    expect(h.profile.toneWarmth).toBe(3);
  });
});
