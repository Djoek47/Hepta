import { describe, expect, it } from 'vitest';

import { createAIUIC } from '../src/engine.js';
import { FakeClock } from '../src/clock.js';
import { ActDefinitionError, defineAct } from '../src/define.js';
import { classify, cloneSlots } from '../src/act-run.js';
import { effectiveRadius, explainRadius, holdDurationMs } from '../src/radius.js';
import {
  ATTENTIVE,
  MAYA,
  ME,
  POCKETED,
  SAM,
  addItem,
  assignChore,
  assignErrand,
  candidate,
  makeCtx,
  massDm,
  newDb,
  rescheduleErrand,
  settleUp,
} from './fixtures.js';
import type { Ctx } from '../src/types.js';

const T0 = 1_700_000_000_000;

/** Let queued microtasks and effect promises run. */
declare const setTimeout: (fn: () => void, ms: number) => unknown;
const tick = () => new Promise<void>((r) => setTimeout(() => r(), 0));

function harness(over: Partial<Ctx> = {}) {
  const db = newDb();
  const clock = new FakeClock(T0);
  let ctxOver = { ...over };
  const ui = createAIUIC({
    clock,
    ctx: () => makeCtx(db, ctxOver),
  });
  return {
    db,
    clock,
    ui,
    setCtx: (o: Partial<Ctx>) => {
      ctxOver = { ...ctxOver, ...o };
    },
    async advance(ms: number) {
      clock.advance(ms);
      await tick();
    },
  };
}

// ---------------------------------------------------------------- §4 checks

describe('definition-time checks', () => {
  it('rejects a function radius with no static max', () => {
    expect(() =>
      defineAct({
        name: 'bad',
        slots: { a: { primitive: 'chip', options: () => [], order: 1 } },
        // @ts-expect-error deliberately missing max
        radius: { of: () => 'self' },
        commit: () => ({ id: '1' }),
        undo: () => {},
      }),
    ).toThrow(ActDefinitionError);
  });

  it('rejects a non-deferrable effect below external', () => {
    expect(() =>
      defineAct({
        name: 'laundered',
        slots: { a: { primitive: 'chip', options: () => [], order: 1 } },
        radius: 'shared',
        commit: () => ({ id: '1' }),
        undo: () => {},
        effects: [
          { name: 'send', run: () => {}, radius: 'shared', reversible: true, deferrable: false },
        ],
      }),
    ).toThrow(/not deferrable/);
  });

  it('rejects an act below external with no undo', () => {
    expect(() =>
      defineAct({
        name: 'no-undo',
        slots: { a: { primitive: 'chip', options: () => [], order: 1 } },
        radius: 'shared',
        commit: () => ({ id: '1' }),
      }),
    ).toThrow(/no undo\(\)/);
  });

  it('rejects an effect whose radius exceeds the act max', () => {
    expect(() =>
      defineAct({
        name: 'over',
        slots: { a: { primitive: 'chip', options: () => [], order: 1 } },
        radius: 'shared',
        commit: () => ({ id: '1' }),
        undo: () => {},
        effects: [
          { name: 'x', run: () => {}, radius: 'external', reversible: true, deferrable: true },
        ],
      }),
    ).toThrow(/above the act's max/);
  });

  it('rejects duplicate slot order', () => {
    expect(() =>
      defineAct({
        name: 'dupe',
        slots: {
          a: { primitive: 'chip', options: () => [], order: 1 },
          b: { primitive: 'chip', options: () => [], order: 1 },
        },
        radius: 'self',
        commit: () => ({ id: '1' }),
        undo: () => {},
      }),
    ).toThrow(/reuses order/);
  });
});

// ---------------------------------------------------------------- §4 radius

describe('effective radius', () => {
  it('is self when the actor assigns to themselves', () => {
    const db = newDb();
    const def = assignChore(db);
    const ctx = { ...makeCtx(db), now: new Date(T0) } as Ctx;
    expect(effectiveRadius(def, { assignee: ME, chore: 'dishes' }, ctx)).toBe('self');
    expect(effectiveRadius(def, { assignee: SAM, chore: 'dishes' }, ctx)).toBe('other-person');
  });

  it('escalates to external when an effect reaches more than reachLimit', () => {
    const db = newDb();
    const def = defineAct({
      name: 'broadcast',
      slots: { msg: { primitive: 'ghostField', options: () => [], required: true, order: 1 } },
      radius: { max: 'external', of: () => 'shared' },
      commit: () => ({ id: '1' }),
      undo: () => {},
      effects: [
        {
          name: 'fanout',
          run: () => {},
          radius: 'shared',
          reversible: true,
          deferrable: true,
          reach: () => 50,
        },
      ],
    });
    const ctx = { ...makeCtx(db), now: new Date(T0) } as Ctx;
    const b = explainRadius(def, { msg: 'hi' }, ctx);
    expect(b.commit).toBe('shared');
    expect(b.radius).toBe('external');
    expect(b.effects[0]?.why).toMatch(/reach 50/);
  });

  it('escalates when an effect is irreversible, however the commit is described', () => {
    const db = newDb();
    const def = massDm(db);
    const ctx = { ...makeCtx(db), now: new Date(T0) } as Ctx;
    expect(effectiveRadius(def, {}, ctx)).toBe('external');
  });

  it('multiplies base pause by the write, not the speaker', () => {
    const ctx = { actor: ME, attention: ATTENTIVE, now: new Date(T0) } as unknown as Ctx;
    expect(holdDurationMs('self', ctx)).toBe(850);
    expect(holdDurationMs('shared', ctx)).toBe(850);
    expect(holdDurationMs('other-person', ctx)).toBe(1360);

    const slow = { ...ctx, actor: { id: 'u2', basePauseMs: 1300 } } as Ctx;
    expect(holdDurationMs('self', slow)).toBe(1300);
    expect(holdDurationMs('other-person', slow)).toBe(2080);
  });
});

// ---------------------------------------------------------------- §8 fills

describe('local fill classification', () => {
  it('confirms a clear unique match', () => {
    const c = classify([candidate(SAM, 0.97), candidate(MAYA, 0.2)]);
    expect(c.outcome).toBe('filled');
    expect(c.provisional).toBe(false);
  });

  it('narrows two close candidates rather than guessing', () => {
    const c = classify([candidate(SAM, 0.9), candidate(MAYA, 0.86)]);
    expect(c.outcome).toBe('narrowed');
  });

  it('fills but flags a single weak match', () => {
    const c = classify([candidate(SAM, 0.6)]);
    expect(c.outcome).toBe('filled');
    expect(c.provisional).toBe(true);
  });
});

// ------------------------------------------------------------ §5 lifecycle

describe('silence commits', () => {
  it('holds for the radius duration, then commits', async () => {
    const h = harness();
    h.ui.defineAct(assignErrand(h.db));
    const run = h.ui.start('assign_errand');

    run.setValue('assignee', SAM, 'spoken');
    run.setValue('errand', 'parcel', 'spoken');
    run.setValue('due', 'friday', 'spoken');

    expect(run.status).toBe('hold');
    expect(run.holdDurationMsValue).toBe(1360);

    await h.advance(1359);
    expect(run.status).toBe('hold');

    await h.advance(2);
    expect(run.status).toBe('settled');
    expect(h.db.items.size).toBe(1);
  });

  it('drops to self scope, and sends nothing, when you assign yourself', async () => {
    const h = harness();
    h.ui.defineAct(assignErrand(h.db));
    const run = h.ui.start('assign_errand');
    run.setValue('assignee', ME, 'spoken');
    run.setValue('errand', 'parcel', 'spoken');

    expect(run.radius).toBe('self');
    expect(run.holdDurationMsValue).toBe(850);

    await h.advance(900);
    await h.advance(6000);
    expect(run.status).toBe('settled');
    expect(h.db.sent).toHaveLength(0);
  });

  it('does not silence-commit when the attention gate fails', async () => {
    const h = harness({ attention: POCKETED });
    h.ui.defineAct(assignErrand(h.db));
    const run = h.ui.start('assign_errand');
    run.setValue('assignee', SAM, 'spoken');
    run.setValue('errand', 'parcel', 'spoken');

    expect(run.status).toBe('explicit');
    expect(run.state().gateFailures).toContain('device locked');

    await h.advance(10_000);
    expect(run.status).toBe('explicit');
    expect(h.db.items.size).toBe(0);
  });

  it('requires engagement in this act before silence counts', () => {
    const h = harness();
    h.ui.defineAct(addItem(h.db));
    const run = h.ui.start('add_item');
    run.setValue('item', 'milk', 'model'); // model filled it; user said nothing
    expect(run.status).toBe('explicit');
    expect(run.state().gateFailures).toContain(
      'user has not touched or spoken during this act',
    );
  });

  it('never rings for an external act; explicit assent runs the effect', async () => {
    const h = harness();
    h.ui.defineAct(settleUp(h.db));
    const run = h.ui.start('settle_up');
    run.setValue('payee', SAM, 'spoken');
    run.setValue('amount', 20, 'spoken');

    expect(run.status).toBe('explicit');
    await h.advance(60_000);
    expect(h.db.paid).toHaveLength(0);

    await run.assent();
    await tick();
    expect(run.status).toBe('settled');
    expect(h.db.paid).toHaveLength(1);
  });
});

// ------------------------------------------------------------ §8 local-first

describe('local-first and the model', () => {
  it('commits with no model at all when local fills are confirmed', async () => {
    const h = harness();
    h.ui.defineAct(assignChore(h.db));
    const run = h.ui.start('assign_chore');

    run.offer('assignee', [candidate(SAM, 0.97), candidate(MAYA, 0.1)], 'spoken');
    run.offer('chore', [candidate('dishes', 0.99)], 'spoken');

    expect(run.slots.assignee?.provisional).toBe(false);
    expect(run.status).toBe('hold');

    await h.advance(1400);
    expect(run.status).toBe('settled');
  });

  it('waits for the model when a consequential slot is provisional', () => {
    const h = harness();
    h.ui.defineAct(assignChore(h.db));
    const run = h.ui.start('assign_chore');

    run.offer('assignee', [candidate(SAM, 0.62)], 'spoken');
    run.offer('chore', [candidate('dishes', 0.99)], 'spoken');

    expect(run.slots.assignee?.provisional).toBe(true);
    expect(run.status).toBe('resolving');

    run.setValue('assignee', MAYA, 'model');
    expect(run.status).toBe('hold');
  });

  it('holds on a provisional fill when the act is self-scoped', () => {
    const h = harness();
    h.ui.defineAct(addItem(h.db));
    const run = h.ui.start('add_item');
    run.offer('item', [candidate('milk', 0.6)], 'spoken');
    expect(run.slots.item?.provisional).toBe(true);
    expect(run.status).toBe('hold');
  });

  it('restarts the clock and marks the slot when a model corrects mid-HOLD', async () => {
    const h = harness();
    h.ui.defineAct(assignErrand(h.db));
    const run = h.ui.start('assign_errand');
    run.setValue('assignee', SAM, 'spoken');
    run.setValue('errand', 'parcel', 'spoken');
    expect(run.status).toBe('hold');

    await h.advance(1000);
    run.setValue('assignee', MAYA, 'model');

    expect(run.status).toBe('hold');
    expect(run.slots.assignee?.corrected).toBe(true);

    await h.advance(1000);
    expect(run.status).toBe('hold'); // clock restarted, not resumed
    await h.advance(400);
    expect(run.status).toBe('settled');
    expect(h.db.items.get('e1')?.assignee).toBe(MAYA);
  });

  it('reports acts that cannot run without a model', () => {
    const h = harness();
    h.ui.defineAct(massDm(h.db));
    h.ui.defineAct(addItem(h.db));
    expect(h.ui.needsModel('mass_dm_ppv')).toBe(true);
    expect(h.ui.needsModel('add_item')).toBe(false);
  });
});

// ---------------------------------------------------------------- §6 repair

describe('repair', () => {
  it('freezes on bare negation and changes nothing', async () => {
    const h = harness();
    h.ui.defineAct(assignErrand(h.db));
    const run = h.ui.start('assign_errand');
    run.setValue('assignee', SAM, 'spoken');
    run.setValue('errand', 'parcel', 'spoken');
    const before = cloneSlots(run.slots);

    run.freeze();

    expect(run.status).toBe('frozen');
    expect(run.slots).toEqual(before);
    await h.advance(10_000);
    expect(h.db.items.size).toBe(0);
  });

  it('comes back to life when the user points at the wrong slot', () => {
    const h = harness();
    h.ui.defineAct(assignErrand(h.db));
    const run = h.ui.start('assign_errand');
    run.setValue('assignee', SAM, 'spoken');
    run.setValue('errand', 'parcel', 'spoken');
    run.freeze();

    run.setValue('assignee', MAYA, 'touched');
    expect(run.status).toBe('hold');
  });

  it('pauses on hangup without undoing, and resumes', async () => {
    const h = harness();
    h.ui.defineAct(assignErrand(h.db));
    const run = h.ui.start('assign_errand');
    run.setValue('assignee', SAM, 'spoken');
    run.setValue('errand', 'parcel', 'spoken');

    run.pause();
    await h.advance(60_000);
    expect(run.status).toBe('frozen');
    expect(h.db.items.size).toBe(0);

    run.resume();
    expect(run.status).toBe('hold');
    await h.advance(1400);
    expect(run.status).toBe('settled');
  });

  it('blocks HOLD when a filled value goes stale on resume', () => {
    const h = harness();
    h.ui.defineAct(assignErrand(h.db));
    const run = h.ui.start('assign_errand');
    run.setValue('assignee', SAM, 'spoken');
    run.setValue('errand', 'parcel', 'spoken');
    expect(run.status).toBe('hold');

    run.markStale('assignee');
    expect(run.status).toBe('resolving');
  });
});

// ---------------------------------------------------------------- §7 outbox

describe('outbox and undo', () => {
  it('holds the notification for the undo window', async () => {
    const h = harness();
    h.ui.defineAct(assignErrand(h.db));
    const run = h.ui.start('assign_errand');
    run.setValue('assignee', SAM, 'spoken');
    run.setValue('errand', 'parcel', 'spoken');

    await h.advance(1400);
    expect(run.status).toBe('settled');
    expect(h.db.sent).toHaveLength(0);
    expect(h.ui.outbox.size).toBe(1);

    await h.advance(5000);
    expect(h.db.sent).toEqual(['e1']);
  });

  it('undo inside the window reverses the write and discards the effect', async () => {
    const h = harness();
    h.ui.defineAct(assignErrand(h.db));
    const run = h.ui.start('assign_errand');
    run.setValue('assignee', SAM, 'spoken');
    run.setValue('errand', 'parcel', 'spoken');

    await h.advance(1400);
    expect(h.db.items.size).toBe(1);

    expect(run.undoAvailable).toBe(true);
    expect(await run.undo()).toBe(true);

    expect(h.db.items.size).toBe(0);
    await h.advance(10_000);
    expect(h.db.sent).toHaveLength(0);
  });

  it('refuses undo once the window has closed', async () => {
    const h = harness();
    h.ui.defineAct(assignErrand(h.db));
    const run = h.ui.start('assign_errand');
    run.setValue('assignee', SAM, 'spoken');
    run.setValue('errand', 'parcel', 'spoken');

    await h.advance(1400);
    await h.advance(5001);
    expect(run.undoAvailable).toBe(false);
    expect(await run.undo()).toBe(false);
    expect(h.db.sent).toHaveLength(1);
  });

  it('restores a persisted outbox with the remaining time, never early', async () => {
    const h = harness();
    h.ui.defineAct(assignErrand(h.db));
    const run = h.ui.start('assign_errand');
    run.setValue('assignee', SAM, 'spoken');
    run.setValue('errand', 'parcel', 'spoken');
    await h.advance(1400);

    const saved = h.ui.serializeOutbox();
    expect(saved).toHaveLength(1);

    // Relaunch 2s later: 3s should remain.
    const clock2 = new FakeClock(h.clock.now() + 2000);
    const ui2 = createAIUIC({ clock: clock2, ctx: () => makeCtx(h.db) });
    ui2.defineAct(assignErrand(h.db));
    ui2.restoreOutbox(saved);

    clock2.advance(2900);
    await tick();
    expect(h.db.sent).toHaveLength(0);

    clock2.advance(200);
    await tick();
    expect(h.db.sent).toEqual(['e1']);
  });

  it('a failed effect is reported and does not reverse the commit', async () => {
    const h = harness();
    const def = assignErrand(h.db);
    def.effects![0]!.run = () => {
      throw new Error('push service down');
    };
    h.ui.defineAct(def);
    const run = h.ui.start('assign_errand');
    run.setValue('assignee', SAM, 'spoken');
    run.setValue('errand', 'parcel', 'spoken');

    await h.advance(1400);
    await h.advance(5001);
    expect(run.status).toBe('settled');
    expect(h.db.items.size).toBe(1);
  });
});

// -------------------------------------------------- §4 clock-dependent radius

describe('radius that depends on the clock', () => {
  it('holds for a move far in the future', () => {
    const h = harness();
    h.db.items.set('pharmacy', { when: T0 + 3_600_000 });
    h.ui.defineAct(rescheduleErrand(h.db));
    const run = h.ui.start('reschedule_errand');
    run.setValue('errand', 'pharmacy', 'spoken');
    run.setValue('when', T0 + 30 * 60_000, 'spoken');
    expect(run.radius).toBe('shared');
    expect(run.status).toBe('hold');
  });

  it('demands explicit assent for a move that is effectively now', () => {
    const h = harness();
    h.db.items.set('pharmacy', { when: T0 + 3_600_000 });
    h.ui.defineAct(rescheduleErrand(h.db));
    const run = h.ui.start('reschedule_errand');
    run.setValue('errand', 'pharmacy', 'spoken');
    run.setValue('when', T0 + 3 * 60_000, 'spoken');
    expect(run.radius).toBe('external');
    expect(run.status).toBe('explicit');
  });

  it('restores the previous value on undo of an update', async () => {
    const h = harness();
    h.db.items.set('pharmacy', { when: T0 + 3_600_000 });
    h.ui.defineAct(rescheduleErrand(h.db));
    const run = h.ui.start('reschedule_errand');
    run.setValue('errand', 'pharmacy', 'spoken');
    run.setValue('when', T0 + 30 * 60_000, 'spoken');

    await h.advance(900);
    expect(h.db.items.get('pharmacy')?.when).toBe(T0 + 30 * 60_000);

    await run.undo();
    expect(h.db.items.get('pharmacy')?.when).toBe(T0 + 3_600_000);
  });
});
