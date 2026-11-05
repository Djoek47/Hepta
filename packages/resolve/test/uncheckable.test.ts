import { describe, expect, it } from 'vitest';
import { defineAct, type ActDef, type Ctx } from '@intermenu/aiuic-core';
import { LocalResolver, pickAct, remainder, resolveQuantity, resolveWhen } from '../src/index.js';

const PEOPLE = [{ value: 'maya', label: 'Maya' }, { value: 'sam', label: 'Sam' }];
const acts: ActDef[] = [
  defineAct({ name: 'add_chore', phrases: ['add', 'add a chore'], radius: 'external', commit: () => ({ id: '1' }), slots: {
    who: { primitive: 'face', options: () => PEOPLE, required: true, order: 1 },
    what: { primitive: 'ghostField', resolve: remainder(['add']), required: true, order: 2 },
    when: { primitive: 'when', resolve: resolveWhen, required: true, order: 3 } } }),
  defineAct({ name: 'add_groceries', phrases: ['add', 'add groceries'], radius: 'external', commit: () => ({ id: '2' }), slots: {
    what: { primitive: 'ghostField', resolve: remainder(['add']), required: true, order: 1 } } }),
  defineAct({ name: 'pay', phrases: ['pay'], radius: 'external', commit: () => ({ id: '3' }), slots: {
    who: { primitive: 'face', options: () => PEOPLE, required: true, order: 1 },
    amount: { primitive: 'quantity', resolve: resolveQuantity, required: true, order: 2 } } }),
  defineAct({ name: 'plan_event', phrases: ['plan'], radius: 'external', commit: () => ({ id: '4' }), slots: {
    what: { primitive: 'ghostField', resolve: remainder(['plan']), required: true, order: 1 },
    when: { primitive: 'when', resolve: resolveWhen, required: true, order: 2 },
    who: { primitive: 'face', options: () => PEOPLE, required: true, order: 3 } } }),
  defineAct({ name: 'send_weekly', phrases: ['send', 'send the weekly'], radius: 'external', commit: () => ({ id: '5' }), slots: {
    what: { primitive: 'ghostField', resolve: remainder(['send']), required: true, order: 1 } } }),
];
const ctx = { now: new Date(Date.UTC(2026, 8, 25, 12)), actor: { id: 'me' } } as Ctx;
const optionsFor = (a: ActDef, s: string) => (a.slots[s]?.options?.(ctx, {}) ?? []) as { value: unknown; label: string }[];
const route = (t: string) => {
  const d = pickAct(new LocalResolver().scoreSync(t, acts, ctx, optionsFor));
  return d.kind === 'start' ? d.act : d.kind === 'narrow' ? d.acts[0] : null;
};

describe('an act that asks only for free text', () => {
  it('routes on its phrase when nothing else claims the sentence', () => {
    expect(route('add milk')).toBe('add_groceries');
    expect(route('send the weekly summary')).toBe('send_weekly');
  });
  it('loses to an act whose slots are actually evidenced, when they share a phrase', () => {
    expect(route('add the dishes for Maya tomorrow')).toBe('add_chore');
  });
});

describe('a sentence that mentions things without asking for them (found by the harder eval suite)', () => {
  const CHORES = [{ value: 'dishes', label: 'dishes' }, { value: 'laundry', label: 'laundry' }, { value: 'trash', label: 'trash', aliases: ['bins'] }];
  const home: ActDef[] = [
    defineAct({ name: 'assign_chore', phrases: ['for'], radius: 'external', commit: () => ({ id: '1' }), slots: {
      who: { primitive: 'face', options: () => PEOPLE, required: true, order: 1 },
      chore: { primitive: 'chip', options: () => CHORES, required: true, order: 2 } } }),
    defineAct({ name: 'settle_up', phrases: ['pay'], radius: 'external', commit: () => ({ id: '2' }), slots: {
      who: { primitive: 'face', options: () => PEOPLE, required: true, order: 1 },
      amount: { primitive: 'quantity', resolve: resolveQuantity, required: true, order: 2 } } }),
  ];
  const opts = (a: ActDef, s: string) => (a.slots[s]?.options?.(ctx, {}) ?? []) as { value: unknown; label: string }[];
  const at = (t: string) => pickAct(new LocalResolver().scoreSync(t, home, ctx, opts)).kind;

  it('opens no card for a chore, a person or an amount mentioned in passing', () => {
    expect(at('I love doing the dishes')).toBe('none');
    expect(at('did Sam already take the bins out')).toBe('none');
    expect(at('twenty dollars is a lot')).toBe('none');
    // Every slot filled, and still a question: this one reached HOLD in the Hepta replay.
    expect(at('did Sam do the laundry')).toBe('none');
  });
  it('still hears the same words as a request', () => {
    expect(at('do the laundry')).toBe('start');
    expect(at('can you do the dishes')).toBe('start');
    // This was a pinned "known limit" (a trigger phrase overrode the sentence shape). The second
    // review showed the same rule let "who did the dishes for Sam?" reach HOLD on an act that
    // commits on silence, so it is closed: a question opens no card, even one naming the act.
    expect(at('did you pay Maya 20 dollars')).toBe('none');
  });
});

describe('a question may ask for something that changes nothing', () => {
  const brief = defineAct({ name: 'get_briefing', phrases: ['brief me', 'what did i miss', 'catch me up'], radius: 'self',
    commit: () => ({ id: '1' }), undo: () => {},
    slots: { length: { primitive: 'chip', options: () => [{ value: 15, label: 'Standard' }], default: () => 15, required: true, order: 1 } } });
  const swap = defineAct({ name: 'swap_chore', phrases: ['for'], radius: 'self', commit: () => ({ id: '2' }), undo: () => {},
    slots: { who: { primitive: 'face', options: () => PEOPLE, required: true, order: 1 } } });
  const pay = defineAct({ name: 'pay', phrases: ['did you pay', 'pay'], radius: 'external', commit: () => ({ id: '3' }),
    slots: { who: { primitive: 'face', options: () => PEOPLE, required: true, order: 1 } } });
  const opts = (a: ActDef, s: string) => (a.slots[s]?.options?.(ctx, {}) ?? []) as { value: unknown; label: string }[];
  const at = (t: string, acts: ActDef[]) => {
    const d = pickAct(new LocalResolver().scoreSync(t, acts, ctx, opts));
    return d.kind === 'start' ? d.act : d.kind;
  };

  it('opens a briefing when it is asked for as a question', () => {
    expect(at('what did I miss?', [brief])).toBe('get_briefing');
  });
  it('but a single common word never turns a question into a request', () => {
    expect(at('who did the dishes for Sam?', [swap])).toBe('none');
  });
  it('and nothing that touches somebody else is ever started by a question, whatever phrase it matches', () => {
    expect(at('did you pay Maya?', [pay])).toBe('none');
  });
});
