/**
 * Replay the speech suite through Hepta and print the numbers.
 *
 *   npm run hepta
 *
 * EARLY COMMITS is the one to watch. Everything else is a tuning question.
 */

import { createAIUIC, defineAct, FakeClock, type ActDef, type Ctx, type Option } from '@intermenu/aiuic-core';
import { LocalResolver, resolveQuantity, resolveWhen } from '@intermenu/aiuic-resolve';
import { Speculator } from './src/index.js';
import { formatSpeculation, formatTrace, replay, speculationReport, type Trace } from './src/replay.js';
import { speech } from './suites/speech.js';
import { debate } from './suites/debate.js';
import { debateReport, formatDebate, replayDebate } from './src/debate-replay.js';

const PEOPLE: Option[] = [
  { value: { id: 'maya', label: 'Maya' }, label: 'Maya', aliases: ['maya'] },
  { value: { id: 'sam', label: 'Sam' }, label: 'Sam', aliases: ['sam'] },
];
const CHORES: Option[] = [
  { value: 'dishes', label: 'Dishes', aliases: ['the dishes', 'vaisselle'] },
  { value: 'laundry', label: 'Laundry', aliases: ['the laundry', 'lessive'] },
];
const ITEMS: Option[] = [
  { value: 'milk', label: 'Milk' }, { value: 'jam', label: 'Jam' },
  { value: 'bread', label: 'Bread' }, { value: 'eggs', label: 'Eggs' },
];

const optionsFor = (act: ActDef, slot: string) => {
  const sd = act.slots[slot];
  return sd?.options ? (sd.options({} as Ctx, {}) as Option[]) : [];
};

const clock = new FakeClock(1_700_000_000_000);
const ui = createAIUIC({
  clock,
  ctx: () => ({
    actor: { id: 'me', basePauseMs: 850 },
    attention: { foreground: true, unlocked: true, proximityClear: true, listening: true },
    reachLimit: 1, undoWindowMs: 5000,
  }),
});

ui.defineAct(defineAct({
  name: 'assign_chore', domain: 'chores', phrases: ['for', 'assign', 'needs to do', 'should do', 'give', 'pour'],
  slots: {
    chore: { primitive: 'chip', options: () => CHORES, required: true, order: 1 },
    assignee: { primitive: 'face', options: () => PEOPLE, required: true, order: 2 },
    due: { primitive: 'when', resolve: resolveWhen, order: 3 },
  },
  radius: { max: 'other-person', of: () => 'other-person' },
  commit: () => ({ id: 'c1' }), undo: () => {},
}));
ui.defineAct(defineAct({
  name: 'add_items', domain: 'groceries', phrases: ['add', 'we need', 'put on the list'],
  slots: { item: { primitive: 'chip', options: () => ITEMS, required: true, order: 1 } },
  radius: 'self', commit: () => ({ id: 'g1' }), undo: () => {},
}));
ui.defineAct(defineAct({
  name: 'settle_up', domain: 'allowance', phrases: ['pay', 'send', 'settle up', 'should get', 'payer'],
  slots: {
    payee: { primitive: 'face', options: () => PEOPLE, required: true, order: 1 },
    amount: { primitive: 'quantity', resolve: resolveQuantity, required: true, order: 2 },
  },
  radius: 'external', commit: () => ({ id: 'p1' }),
}));

const ctx = { now: new Date(clock.now()), actor: { id: 'me' } } as Ctx;
const spec = new Speculator(ui, new LocalResolver(), optionsFor);

const traces: Trace[] = [];
for (const kase of speech) {
  spec.reset();
  traces.push(replay(spec, kase, ctx));
}

const report = speculationReport(traces);
console.log(formatSpeculation(report));

console.log('\n--- every sentence, word by word ---\n');
for (const t of traces) console.log(formatTrace(t) + '\n');

console.log('\n=== lines of thought: when to cut in ===\n');
console.log(formatDebate(debateReport(debate.map((c) => replayDebate(c)))));
