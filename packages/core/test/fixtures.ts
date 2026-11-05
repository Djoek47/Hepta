/**
 * The validation acts from spec v0.2 §11, as executable fixtures.
 * Hosts are mocks: the point is the contract, not the data layer.
 */

import { defineAct } from '../src/define.js';
import type { ActDef, Candidate, CommitResult, Ctx, Filled } from '../src/types.js';

export const ME = { id: 'u_me', basePauseMs: 850 };
export const SAM = { id: 'u_sam', label: 'Sam' };
export const MAYA = { id: 'u_maya', label: 'Maya' };

export const ATTENTIVE = {
  foreground: true,
  unlocked: true,
  proximityClear: true,
  listening: true,
};

export const POCKETED = {
  foreground: true,
  unlocked: false,
  proximityClear: false,
  listening: true,
};

export type Db = {
  items: Map<string, Filled>;
  sent: string[];
  paid: string[];
  seq: number;
};

export function newDb(): Db {
  return { items: new Map(), sent: [], paid: [], seq: 1 };
}

export function makeCtx(db: Db, over: Partial<Ctx> = {}): Omit<Ctx, 'now'> {
  return {
    actor: ME,
    attention: ATTENTIVE,
    reachLimit: 1,
    undoWindowMs: 5000,
    db,
    ...over,
  } as Omit<Ctx, 'now'>;
}

const people = () => [
  { value: SAM, label: 'Sam' },
  { value: MAYA, label: 'Maya' },
];

export function candidate(value: unknown, score: number): Candidate {
  return { value, score };
}

// ---------------------------------------------------------------- Sample app

/** "add milk" — self-scoped, trivially reversible. */
export function addItem(db: Db): ActDef {
  return defineAct({
    name: 'add_item',
    phrases: ['add'],
    slots: {
      item: { primitive: 'chip', options: () => [], resolve: () => [], required: true, order: 1 },
    },
    radius: 'self',
    commit: (f) => {
      const id = `i${db.seq++}`;
      db.items.set(id, { ...f });
      return { id };
    },
    undo: (r) => {
      db.items.delete(r.id);
    },
  });
}

/** "Sam picks up the parcel Friday" — touches another person, notify deferred. */
export function assignErrand(db: Db): ActDef {
  return defineAct({
    name: 'assign_errand',
    phrases: ['assign', 'picks up'],
    slots: {
      assignee: { primitive: 'face', options: people, required: true, order: 1 },
      errand: { primitive: 'chip', options: () => [], required: true, order: 2 },
      due: { primitive: 'when', params: { granularity: 'day' }, options: () => [], order: 3 },
    },
    radius: {
      max: 'other-person',
      of: (f: Filled, c: Ctx) =>
        (f.assignee as { id: string } | undefined)?.id === c.actor.id ? 'self' : 'other-person',
    },
    commit: (f) => {
      const id = `e${db.seq++}`;
      db.items.set(id, { ...f });
      return { id };
    },
    undo: (r) => {
      db.items.delete(r.id);
    },
    effects: [
      {
        name: 'notify',
        // Nobody is notified when you assign yourself an errand.
        when: (f, c) => (f.assignee as { id: string } | undefined)?.id !== c.actor.id,
        run: (r) => {
          db.sent.push(r.id);
        },
        radius: 'other-person',
        reversible: true,
        deferrable: true,
        reach: () => 1,
      },
    ],
  });
}

/** "move the pharmacy run to Saturday" — update-style, needs `previous`. */
export function rescheduleErrand(db: Db): ActDef {
  return defineAct({
    name: 'reschedule_errand',
    phrases: ['move', 'reschedule'],
    slots: {
      errand: { primitive: 'objectCard', options: () => [], required: true, order: 1 },
      when: { primitive: 'when', params: { granularity: 'minute' }, options: () => [], required: true, order: 2 },
    },
    // Moving something to "now" is publishing it: irreversible in practice.
    radius: {
      max: 'external',
      of: (f: Filled, c: Ctx) => {
        const at = f.when as number | undefined;
        if (typeof at !== 'number') return 'shared';
        const minutes = (at - c.now.getTime()) / 60000;
        return minutes < 7 ? 'external' : 'shared';
      },
    },
    commit: (f) => {
      const id = String(f.errand);
      const previous = db.items.get(id)?.when ?? null;
      db.items.set(id, { ...(db.items.get(id) ?? {}), when: f.when });
      return { id, previous };
    },
    undo: (r) => {
      const cur = db.items.get(r.id) ?? {};
      db.items.set(r.id, { ...cur, when: r.previous });
    },
  });
}

/** "pay Sam back twenty dollars" — money leaves; explicit only. */
export function settleUp(db: Db): ActDef {
  return defineAct({
    name: 'settle_up',
    phrases: ['pay', 'settle up'],
    slots: {
      payee: { primitive: 'face', options: people, required: true, order: 1 },
      amount: {
        primitive: 'quantity',
        params: { unit: { kind: 'currency', code: 'CAD' } },
        options: () => [],
        required: true,
        order: 2,
      },
    },
    radius: 'external',
    commit: (f) => {
      const id = `p${db.seq++}`;
      db.items.set(id, { ...f });
      return { id };
    },
    effects: [
      {
        name: 'transfer',
        run: (r) => {
          db.paid.push(r.id);
        },
        radius: 'external',
        reversible: false,
        deferrable: false,
      },
    ],
  });
}

/** §11 A — the chore act, second domain. */
export function assignChore(db: Db): ActDef {
  return defineAct({
    name: 'assign_chore',
    slots: {
      assignee: { primitive: 'face', options: people, required: true, order: 1 },
      chore: { primitive: 'chip', options: () => [], required: true, order: 2 },
      due: { primitive: 'when', options: () => [], default: () => 'tomorrow', order: 3 },
    },
    radius: {
      max: 'other-person',
      of: (f: Filled, c: Ctx) =>
        (f.assignee as { id: string } | undefined)?.id === c.actor.id ? 'self' : 'other-person',
    },
    commit: (f) => {
      const id = `c${db.seq++}`;
      db.items.set(id, { ...f });
      return { id } satisfies CommitResult;
    },
    undo: (r) => {
      db.items.delete(r.id);
    },
    effects: [
      {
        name: 'notify',
        when: (f, c) => (f.assignee as { id: string } | undefined)?.id !== c.actor.id,
        run: (r) => {
          db.sent.push(r.id);
        },
        radius: 'other-person',
        reversible: true,
        deferrable: true,
        reach: () => 1,
      },
    ],
  });
}

/** §11 B — the PPV mass DM, whose send reaches hundreds. */
export function massDm(db: Db, audienceCount = 214): ActDef {
  return defineAct({
    name: 'mass_dm_ppv',
    phrases: ['mass dm', 'blast'],
    slots: {
      audience: { primitive: 'chip', options: () => [], required: true, order: 1 },
      unlockPrice: {
        primitive: 'quantity',
        params: { unit: { kind: 'currency' } },
        options: () => [],
        required: true,
        order: 2,
      },
      message: { primitive: 'ghostField', fill: 'model', options: () => [], required: true, order: 3 },
    },
    radius: 'external',
    commit: (f) => {
      const id = `d${db.seq++}`;
      db.items.set(id, { ...f });
      return { id };
    },
    undo: (r) => {
      db.items.delete(r.id);
    },
    effects: [
      {
        name: 'send',
        run: (r) => {
          db.sent.push(r.id);
        },
        radius: 'external',
        reversible: false,
        deferrable: false,
        reach: () => audienceCount,
      },
    ],
  });
}
