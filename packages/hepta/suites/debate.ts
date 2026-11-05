/**
 * Conversations where it should, and should not, cut in.
 *
 * The number that matters here is not how often it interrupts correctly. It
 * is how often it interrupts WRONGLY — cutting someone off for nothing is the
 * failure people do not forgive, and a system that interrupts rightly nine
 * times and wrongly once will be turned off after the one.
 */

export type DebateCase = {
  name: string;
  /** Said earlier, as finished sentences. */
  before: string[];
  /** Views it holds going in. */
  stances?: { topic: string; keys: string[]; position: string; confidence: number; against: string[] }[];
  /** The sentence it hears now. */
  now: string;
  /** What Hepta's foreground is leading with while it is said. */
  leader?: { act: string; radius: string };
  /** Should it cut in? `end` means: not mid-sentence, but raise it when they finish. */
  expect: 'cut' | 'end' | 'quiet';
  bluntness?: number;
};

export const debate: DebateCase[] = [
  {
    name: 'contradicts a number said earlier',
    before: ['my grocery budget is 400'],
    now: 'I think the grocery budget is going to be 650 and I am fine with that',
    expect: 'cut',
  },
  {
    name: 'a small revision is not a contradiction',
    before: ['my grocery budget is 400'],
    now: 'the grocery budget is more like 420 this month and that is fine',
    expect: 'quiet',
  },
  {
    name: 'a payment against a view it holds, said confidently',
    before: [],
    stances: [{ topic: 'the trip fund', keys: ['trip'], position: "That's the trip money.", confidence: 0.9, against: ['settle_up'] }],
    now: 'send Sam four hundred dollars from savings',
    leader: { act: 'settle_up', radius: 'external' },
    expect: 'cut',
  },
  {
    name: 'a view it holds weakly waits for the end',
    before: [],
    stances: [{ topic: 'takeout', keys: ['takeout'], position: 'That is the third takeout this week.', confidence: 0.3, against: ['add_item'] }],
    now: 'add pizza to the list for tonight',
    leader: { act: 'add_item', radius: 'self' },
    expect: 'end',
  },
  {
    name: 'an unrelated sentence leaves it quiet',
    before: ['my grocery budget is 400'],
    now: 'can you remind me to call my mother on sunday',
    expect: 'quiet',
  },
  {
    name: 'the topic comes back without a conflict',
    before: ['my rent budget is 1450'],
    now: 'I was thinking about the rent budget again last night',
    expect: 'end',
  },
  {
    name: 'a mild view, gentle setting: never cuts, still says it',
    before: [],
    stances: [{ topic: 'sleep', keys: ['sleep'], position: 'You said you wanted to be asleep by eleven.', confidence: 0.6, against: ['add_event'] }],
    now: 'book a late call at midnight with the team',
    leader: { act: 'add_event', radius: 'shared' },
    bluntness: 0,
    expect: 'end',
  },

  // ---- the harder half
  {
    name: 'fr: contradicts a number said earlier',
    before: ['mon budget courses est de 400'],
    now: 'je pense que le budget courses va être de 650 et ça me va',
    expect: 'cut',
  },
  {
    name: 'a contradiction said in words',
    before: ['my grocery budget is four hundred'],
    now: 'I think the grocery budget is going to be six hundred and fifty and I am fine with that',
    expect: 'cut',
  },
  {
    name: 'the same number, said in words, is not cut at its first word',
    before: ['my grocery budget is 400'],
    now: 'the grocery budget is going to be four hundred like we said',
    expect: 'quiet',
  },
  {
    name: 'corrects itself back before it can be cut',
    before: ['my grocery budget is 400'],
    now: 'the grocery budget is 650, no sorry, 400 like we said',
    expect: 'quiet',
  },
  {
    name: 'a false start does not make a contradiction',
    before: ['my grocery budget is 400'],
    now: 'the the grocery budget is um 400 still',
    expect: 'quiet',
  },
  {
    name: 'someone else said it: raise it at the end, do not cut the speaker off',
    before: ['my grocery budget is 400'],
    now: 'Sam says the grocery budget should be 650 this month',
    expect: 'end',
  },
  {
    name: 'fr: an unrelated sentence leaves it quiet',
    before: ['mon budget courses est de 400'],
    now: 'rappelle-moi d appeler ma mère dimanche',
    expect: 'quiet',
  },
];
