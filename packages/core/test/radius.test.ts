import { describe, expect, it } from 'vitest';
import { admitValue, defineAct, explainRadius, type Candidate, type Ctx } from '../src/index.js';

describe('an act with no undo', () => {
  it('cannot reach a silence commit through a function radius that returns low', () => {
    // max "external" passes the definition-time check, because nothing below
    // external is promised. of() then returns "self". Without a runtime rule
    // this act would HOLD and commit on silence with no way back.
    const def = defineAct({
      name: 'no_way_back',
      slots: { x: { primitive: 'chip', options: () => [{ value: 1, label: 'one' }], required: true, order: 1 } },
      radius: { max: 'external', of: () => 'self' },
      commit: () => ({ id: '1' }),
    });
    const b = explainRadius(def, { x: 1 }, { reachLimit: 1 } as Ctx);
    expect(b.radius).toBe('external');
    expect(b.why).toMatch(/no undo/);
  });
});

describe('admitting a value proposed from outside', () => {
  const ctx = { now: new Date(), actor: { id: 'me' } } as Ctx;
  const PEOPLE = [{ value: { id: 'maya' }, label: 'Maya', aliases: ['my a'] }, { value: { id: 'sam' }, label: 'Sam' }];

  it('takes only a value the host offered, however it is labelled', () => {
    const slot = { primitive: 'face' as const, options: () => PEOPLE, order: 1 };
    expect(admitValue(slot, { id: 'maya' }, ctx)).toEqual({ ok: true, value: PEOPLE[0]!.value });
    expect(admitValue(slot, 'Maya', ctx)).toEqual({ ok: true, value: PEOPLE[0]!.value });
    expect(admitValue(slot, 'my a', ctx)).toEqual({ ok: true, value: PEOPLE[0]!.value });
    // The smuggled one: a stranger wearing a name the host does offer.
    expect(admitValue(slot, { id: 'mallory', label: 'Maya' }, ctx).ok).toBe(false);
  });

  it('re-reads a value through the slot\'s own resolver, so the card and the commit agree', () => {
    // Stands in for the real grammar (core depends on nothing): reads a number out of words.
    const resolve = (text: string): Candidate[] => {
      const m = /\$?(\d+(?:\.\d+)?)/.exec(text);
      return m ? [{ value: { n: Number(m[1]) }, label: m[0], score: 1, calibrated: true }] : [];
    };
    const slot = { primitive: 'quantity' as const, resolve, order: 1 };
    // Label says $50, number says 5000: the words win, and they say $50.
    const a = admitValue(slot, { n: 5000, label: '$50' }, ctx);
    expect(a.ok && (a.value as { n: number }).n).toBe(50);
    // Nothing readable: left empty rather than guessed.
    expect(admitValue(slot, { n: 5000 }, ctx).ok).toBe(false);
  });

  it('lets free text through, because the card shows exactly what is written', () => {
    const slot = { primitive: 'ghostField' as const, order: 1 };
    expect(admitValue(slot, 'call the bank', ctx)).toEqual({ ok: true, value: 'call the bank' });
    expect(admitValue(slot, '   ', ctx).ok).toBe(false);
  });
});

describe('authority is never granted by silence', () => {
  it('waits for an explicit yes on an act that grants authority, even when it costs nothing', async () => {
    const { createAIUIC, FakeClock } = await import('../src/index.js');
    const clock = new FakeClock(1_700_000_000_000);
    let committed = 0;
    const ui = createAIUIC({ clock, ctx: () => ({ actor: { id: 'me', basePauseMs: 850 },
      attention: { foreground: true, unlocked: true, proximityClear: true, listening: true },
      reachLimit: 1, undoWindowMs: 5000 }) as never });
    ui.defineAct(defineAct({ name: 'allow_away', grantsAuthority: true, radius: 'self',
      slots: { on: { primitive: 'chip', options: () => [{ value: true, label: 'On' }], required: true, order: 1 } },
      commit: () => { committed++; return { id: '1' }; }, undo: () => {} }));
    const run = ui.start('allow_away');
    run.setValue('on', true, 'spoken');
    run.evaluate();
    expect(run.status).toBe('explicit');
    clock.advance(60_000);
    await Promise.resolve(); await Promise.resolve();
    expect(committed).toBe(0);
    await run.assent();
    expect(committed).toBe(1);
  });
});
