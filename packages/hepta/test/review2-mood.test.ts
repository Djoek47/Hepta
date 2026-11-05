/**
 * Review 2: sentences that ask for nothing, yet end in HOLD and commit on
 * silence. The acts are the ones in packages/hepta/run.ts (the replay suite).
 */
import { describe, expect, it } from 'vitest';

import { createAIUIC, defineAct, FakeClock, type Ctx, type Option } from '@intermenu/aiuic-core';
import { LocalResolver, resolveWhen, type OptionsFor } from '@intermenu/aiuic-resolve';
import { Speculator } from '../src/index.js';

declare const setTimeout: (fn: () => void, ms: number) => unknown;
const tick = () => new Promise<void>((r) => setTimeout(() => r(), 0));

const PEOPLE: Option[] = [
  { value: { id: 'maya', label: 'Maya' }, label: 'Maya', aliases: ['maya'] },
  { value: { id: 'sam', label: 'Sam' }, label: 'Sam', aliases: ['sam'] },
];
const CHORES: Option[] = [
  { value: 'dishes', label: 'Dishes', aliases: ['the dishes', 'vaisselle'] },
  { value: 'laundry', label: 'Laundry', aliases: ['the laundry', 'lessive'] },
];
const optionsFor: OptionsFor = (_a, slot) => (slot === 'assignee' ? PEOPLE : slot === 'chore' ? CHORES : []);

function build() {
  const clock = new FakeClock(1_700_000_000_000);
  const committed: string[] = [];
  const ctx = (): Ctx => ({
    now: new Date(clock.now()), actor: { id: 'me', basePauseMs: 850 },
    attention: { foreground: true, unlocked: true, proximityClear: true, listening: true },
    reachLimit: 1, undoWindowMs: 5000,
  }) as Ctx;
  const ui = createAIUIC({ clock, ctx });
  ui.defineAct(defineAct({
    name: 'assign_chore', domain: 'chores', phrases: ['for', 'assign', 'needs to do', 'should do', 'give', 'pour'],
    slots: {
      chore: { primitive: 'chip', options: () => CHORES, required: true, order: 1 },
      assignee: { primitive: 'face', options: () => PEOPLE, required: true, order: 2 },
      due: { primitive: 'when', resolve: resolveWhen, order: 3 },
    },
    radius: { max: 'other-person', of: () => 'other-person' },
    commit: () => { committed.push('assign_chore'); return { id: 'c1' }; }, undo: () => {},
  }));
  const spec = new Speculator(ui, new LocalResolver(), optionsFor);
  return { clock, ctx, spec, committed };
}

async function say(text: string) {
  const h = build();
  h.spec.feed({ text, final: true }, h.ctx());
  const status = h.spec.currentRun?.status ?? null;
  h.clock.advance(5000);
  await tick();
  return { status, committed: h.committed };
}

describe('review2: a sentence that asks nothing must not commit on silence', () => {
  it('"can you believe Sam did the dishes" (a remark, not a request) does not hold or commit', async () => {
    // mood() reads the leading "can you" as a polite request.
    const r = await say('can you believe Sam did the dishes');
    expect({ status: r.status, committed: r.committed }).toEqual({ status: expect.not.stringMatching(/^hold$/), committed: [] });
  });

  it('"I need to tell you Maya did the laundry" does not hold or commit', async () => {
    // mood() reads the leading "I need" as a want.
    const r = await say('I need to tell you Maya did the laundry');
    expect({ status: r.status, committed: r.committed }).toEqual({ status: expect.not.stringMatching(/^hold$/), committed: [] });
  });

  it('"who did the dishes for Sam?" (a question) does not hold or commit', async () => {
    // A trigger phrase ("for") bypasses the mood gate entirely; the pinned
    // "known limit" relies on the act being external, and this one is not.
    const r = await say('who did the dishes for Sam?');
    expect({ status: r.status, committed: r.committed }).toEqual({ status: expect.not.stringMatching(/^hold$/), committed: [] });
  });
});
