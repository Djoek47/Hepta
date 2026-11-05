import { defineAct, type ActDef, type Ctx, type Option } from '@intermenu/aiuic-core';

export const DRAKO = { id: 'u_drako', name: 'Drako' };
export const MAYA = { id: 'u_maya', name: 'Maya' };
export const SAM = { id: 'u_sam', name: 'Sam' };

export const PEOPLE: Option[] = [
  { value: DRAKO, label: 'Drako' },
  { value: MAYA, label: 'Maya' },
  { value: SAM, label: 'Sam' },
];

export const CHORES: Option[] = [
  { value: 'dishes', label: 'dishes', aliases: ['do the dishes', 'washing up'] },
  { value: 'trash', label: 'trash', aliases: ['take out the bins', 'garbage'] },
  { value: 'maya_room', label: "Maya's room", aliases: ['tidy Mayas room'] },
];

export const SEGMENTS: Option[] = [
  {
    value: { id: 'seg_exp', label: 'expiring subscribers' },
    label: 'expiring subscribers',
    aliases: ['expiring subs'],
  },
  { value: { id: 'seg_new', label: 'new subscribers' }, label: 'new subscribers', aliases: ['new subs'] },
  { value: { id: 'seg_all', label: 'all fans' }, label: 'all fans' },
];

export const ctx = (): Ctx =>
  ({
    now: new Date('2026-09-23T04:00:00Z'),
    actor: { id: 'u_me' },
    attention: { foreground: true, unlocked: true, proximityClear: true, listening: true },
    reachLimit: 1,
  }) as Ctx;

export const optionsFor = (act: ActDef, slot: string): Option[] => {
  if (slot === 'assignee' || slot === 'payee') return PEOPLE;
  if (slot === 'chore') return CHORES;
  if (slot === 'audience') return SEGMENTS;
  return [];
};

export const assignChore: ActDef = defineAct({
  name: 'assign_chore',
  phrases: ['assign', 'give'],
  slots: {
    assignee: { primitive: 'face', options: () => PEOPLE, required: true, order: 1 },
    chore: { primitive: 'chip', options: () => CHORES, required: true, order: 2 },
    due: { primitive: 'when', options: () => [], order: 3 },
  },
  radius: { max: 'other-person', of: () => 'other-person' },
  commit: () => ({ id: 'c1' }),
  undo: () => {},
});

export const massDm: ActDef = defineAct({
  name: 'mass_dm_ppv',
  phrases: ['mass dm', 'message all', 'blast'],
  slots: {
    audience: { primitive: 'chip', options: () => SEGMENTS, required: true, order: 1 },
    unlockPrice: { primitive: 'quantity', options: () => [], required: true, order: 2 },
    message: { primitive: 'ghostField', fill: 'model', options: () => [], required: true, order: 3 },
  },
  radius: 'external',
  commit: () => ({ id: 'd1' }),
});

export const resubDiscount: ActDef = defineAct({
  name: 'resub_discount',
  phrases: ['discount', 'rebill', 'offer'],
  slots: {
    audience: { primitive: 'chip', options: () => SEGMENTS, required: true, order: 1 },
    price: { primitive: 'quantity', options: () => [], required: true, order: 2 },
  },
  radius: 'external',
  commit: () => ({ id: 'r1' }),
});
