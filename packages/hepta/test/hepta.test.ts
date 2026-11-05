import { describe, expect, it } from 'vitest';

import { createAIUIC, defineAct, FakeClock, type ActDef, type Ctx, type Option } from '@intermenu/aiuic-core';
import { LocalResolver, type OptionsFor } from '@intermenu/aiuic-resolve';
import { Speculator, explainTracks } from '../src/index.js';

const T0 = 1_700_000_000_000;
declare const setTimeout: (fn: () => void, ms: number) => unknown;
const tick = () => new Promise<void>((r) => setTimeout(() => r(), 0));

const SAM = { id: 'sam', label: 'Sam' };
const MAYA = { id: 'maya', label: 'Maya' };
const PEOPLE = [
  { value: SAM, label: 'Sam' },
  { value: MAYA, label: 'Maya' },
];
const ERRANDS = [
  { value: 'parcel', label: 'the parcel', aliases: ['parcel'] },
  { value: 'recycling', label: 'the recycling', aliases: ['recycling'] },
];

const optionsFor: OptionsFor = (_a, slot) =>
  slot === 'assignee' || slot === 'payee' ? PEOPLE : slot === 'errand' ? ERRANDS : [];

function build() {
  const clock = new FakeClock(T0);
  const committed: string[] = [];
  const ctx = (): Ctx =>
    ({
      now: new Date(clock.now()),
      actor: { id: 'me', basePauseMs: 850 },
      attention: { foreground: true, unlocked: true, proximityClear: true, listening: true },
      reachLimit: 1,
      undoWindowMs: 5000,
    }) as Ctx;

  const ui = createAIUIC({ clock, ctx });

  const assign: ActDef = defineAct({
    name: 'assign_errand',
    phrases: ['picks up', 'grabs', 'assign'],
    slots: {
      assignee: { primitive: 'face', options: () => PEOPLE, required: true, order: 1 },
      errand: { primitive: 'chip', options: () => ERRANDS, required: true, order: 2 },
    },
    radius: { max: 'other-person', of: () => 'other-person' },
    commit: () => { committed.push('assign'); return { id: 'e1' }; },
    undo: () => { committed.pop(); },
  });

  const pay: ActDef = defineAct({
    name: 'settle_up',
    phrases: ['pay', 'pay back', 'send money'],
    slots: {
      payee: { primitive: 'face', options: () => PEOPLE, required: true, order: 1 },
      amount: {
        primitive: 'quantity',
        resolve: (t) => {
          const m = /\b(\d+)\b/.exec(t);
          return m ? [{ value: Number(m[1]), score: 1 }] : [];
        },
        required: true,
        order: 2,
      },
    },
    radius: 'external',
    commit: () => { committed.push('pay'); return { id: 'p1' }; },
  });

  ui.defineAct(assign);
  ui.defineAct(pay);

  const spec = new Speculator(ui, new LocalResolver(), optionsFor);
  return { ui, clock, ctx, spec, committed, async advance(ms: number) { clock.advance(ms); await tick(); } };
}

describe('hepta — seven tongues', () => {
  it('paints the leader from a partial utterance', () => {
    const h = build();
    const s = h.spec.feed({ text: 'Sam picks up the parcel', final: false }, h.ctx());
    expect(s.leader).toBe('assign_errand');
    expect(h.spec.currentRun?.status).toBe('speculating');
    expect(h.spec.currentRun?.slots.assignee?.value).toBe(SAM);
    expect(h.spec.currentRun?.slots.errand?.value).toBe('parcel');
  });

  it('never reaches HOLD while the speaker is still talking', async () => {
    const h = build();
    for (const text of ['Sam', 'Sam picks', 'Sam picks up', 'Sam picks up the parcel']) {
      const s = h.spec.feed({ text, final: false }, h.ctx());
      expect(s.run).toBeNull();
      expect(h.spec.currentRun?.status).not.toBe('hold');
    }
    // A full second of "silence" mid-sentence commits nothing.
    await h.advance(2000);
    expect(h.committed).toHaveLength(0);
  });

  it('hands over to the commit contract the moment speech settles', async () => {
    const h = build();
    h.spec.feed({ text: 'Sam picks up the parcel', final: false }, h.ctx());
    const s = h.spec.feed({ text: 'Sam picks up the parcel', final: true }, h.ctx());

    expect(s.run).not.toBeNull();
    expect(s.run!.status).toBe('hold');
    expect(s.run!.holdDurationMsValue).toBe(1360); // other-person, not self

    await h.advance(1400);
    expect(h.committed).toEqual(['assign']);
  });

  it('keeps several acts alive at once, with only one on the stage', () => {
    const h = build();
    const early = h.spec.feed({ text: 'Sam', final: false }, h.ctx());
    expect(early.tracks.map((t) => t.act).sort()).toEqual(['assign_errand', 'settle_up']);

    // More words settle who leads, but a still-plausible act stays alive as a
    // shadow. That is the point: the tongue keeps turning on the alternative.
    const late = h.spec.feed({ text: 'Sam picks up the parcel', final: false }, h.ctx());
    expect(late.leader).toBe('assign_errand');
    expect(late.tracks.map((t) => t.act)).toContain('settle_up');
    expect(late.tracks.filter((t) => t.leading)).toHaveLength(1);
  });

  it('prunes a track once the words rule it out', () => {
    const h = build();
    h.spec.feed({ text: 'Sam', final: false }, h.ctx());
    const s = h.spec.feed({ text: 'the parcel', final: false }, h.ctx());
    expect(s.pruned).toContain('settle_up');
    expect(s.tracks.map((t) => t.act)).toEqual(['assign_errand']);
  });

  it('switches the stage only when a challenger is clearly ahead', () => {
    const h = build();
    h.spec.feed({ text: 'Sam', final: false }, h.ctx());
    const first = h.spec.leaderName;
    const s = h.spec.feed({ text: 'pay Sam 20', final: false }, h.ctx());
    expect(s.leader).toBe('settle_up');
    expect(s.switched).toBe(true);
    expect(first).not.toBe('settle_up');
  });

  it('still refuses to commit an external act once speech settles', async () => {
    const h = build();
    h.spec.feed({ text: 'pay Sam 20', final: false }, h.ctx());
    const s = h.spec.feed({ text: 'pay Sam 20', final: true }, h.ctx());
    expect(s.run!.radius).toBe('external');
    expect(s.run!.status).toBe('explicit');
    await h.advance(60_000);
    expect(h.committed).toHaveLength(0);
  });

  it('refuses to be assented to while still speculating', async () => {
    const h = build();
    h.spec.feed({ text: 'Sam picks up the parcel', final: false }, h.ctx());
    await expect(h.spec.currentRun!.assent()).rejects.toThrow(/settle it first/);
  });

  it('drops everything on reset', () => {
    const h = build();
    h.spec.feed({ text: 'Sam picks up the parcel', final: false }, h.ctx());
    h.spec.reset();
    expect(h.spec.currentRun).toBeNull();
  });

  it('explains its tracks for a readout', () => {
    const h = build();
    const s = h.spec.feed({ text: 'Sam', final: false }, h.ctx());
    const rows = explainTracks(s);
    expect(rows.length).toBe(s.tracks.length);
    expect(rows.some((r) => r.lead)).toBe(true);
    expect(rows[0]!.score).toMatch(/^\d\.\d\d$/);
  });
});

describe('the first evaluate', () => {
  /**
   * ui.start() evaluates before it returns, so for one call there was a run
   * whose `speculative` flag had not been set yet. The question was whether a
   * half-finished sentence could arm a HOLD in that window.
   *
   * It could not, and the reason is worth pinning down, because it is not the
   * reason I expected. A brand-new run has no engagement -- nobody has touched
   * or spoken DURING this act -- so the attention gate fails and the most that
   * first evaluate can reach is `explicit`. The engagement clause was written
   * so that a profile never finalizes itself from defaults; it turns out to be
   * what makes speculation safe as well.
   *
   * That is one clause carrying two jobs, which is fine until someone relaxes
   * it for the first reason without knowing about the second. Hence this test.
   * It fails loudly if engagement ever stops gating a fresh run.
   */
  const buildOne = () => {
    const clock = new FakeClock(T0);
    const ui = createAIUIC({
      clock,
      ctx: () => ({
        actor: { id: 'me', basePauseMs: 850 },
        attention: { foreground: true, unlocked: true, proximityClear: true, listening: true },
        reachLimit: 1, undoWindowMs: 5000,
      }),
    });
    // Every required slot defaults, so the first evaluate finds the act
    // complete. Nothing else in the suite reaches this path.
    ui.defineAct(defineAct({
      name: 'log_mood', phrases: ['log', 'feeling'],
      slots: {
        mood: { primitive: 'chip', options: () => [{ value: 'ok', label: 'okay' }],
                default: () => 'ok', required: true, order: 1 },
      },
      radius: 'self',
      commit: () => ({ id: 'm1' }), undo: () => {},
    }));
    return { ui, clock };
  };

  it('cannot reach HOLD on a fresh run, because nobody has engaged with it', () => {
    const { ui } = buildOne();
    const run = ui.start('log_mood');
    expect(run.status).toBe('explicit');
    expect(run.state().gateFailures).toContain('user has not touched or spoken during this act');
  });

  it('is speculating from birth, so no frame of the contract is ever painted', () => {
    const { ui } = buildOne();
    const run = ui.start('log_mood', { speculative: true });
    expect(run.status).toBe('speculating');
  });

  it('commits nothing while the speaker is still going', async () => {
    const { ui, clock } = buildOne();
    let committed = 0;
    ui.on((e) => { if (e.type === 'commit') committed++; });

    const spec = new Speculator(ui, new LocalResolver(), (act, slot) => {
      const sd = act.slots[slot];
      return sd?.options ? (sd.options({} as Ctx, {}) as Option[]) : [];
    });
    spec.feed({ text: 'log', final: false }, { now: new Date(clock.now()), actor: { id: 'me' } } as Ctx);

    // Well past any hold this act could have armed.
    clock.advance(5000);
    await tick();
    expect(committed).toBe(0);
    expect(spec.currentRun?.status).toBe('speculating');
  });
});
