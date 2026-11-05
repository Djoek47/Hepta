/**
 * Hepta — "il faut tourner sept fois sa langue dans sa bouche avant de parler."
 *
 * The proverb is a rule about restraint, not about speed: you may think as many
 * times as you like, but you do not speak until the turning stops. That is
 * exactly the contract this package enforces.
 *
 * While someone is still talking, Hepta keeps several candidate acts alive at
 * once — up to seven — scoring each against the partial transcript and painting
 * the leader on the stage immediately, so the interface is already most of the
 * way there when the sentence ends. None of them may commit. A partial
 * utterance has no silence in it: the speaker has not stopped, so there is
 * nothing to read as assent. `ActRun.speculative` holds every track at
 * `speculating` until the transcript is final, and only then does the commit
 * contract get to decide.
 *
 * What this is NOT: a speech model. Hepta does not listen, transcribe or speak.
 * It speculates on INTENT over whatever transcript a recognizer hands it, which
 * is the part AIUIC owns.
 */

import type { ActDef, Ctx } from '@intermenu/aiuic-core';
import type { AIUIC, ActRun } from '@intermenu/aiuic-core';
import {
  DEFAULT_ROUTING,
  LocalResolver,
  pickAct,
  type ActScore,
  type OptionsFor,
  type RoutingConfig,
  type SlotCandidates,
} from '@intermenu/aiuic-resolve';

export type Interim = {
  /** The transcript SO FAR. Hepta re-reads it whole; recognizers revise words. */
  text: string;
  /** True once the recognizer says the speaker has stopped. */
  final: boolean;
};

export type Track = {
  act: string;
  score: number;
  /** Required slots with a candidate clearing tau_fill, over required slots. */
  coverage: number;
  /** How well a trigger phrase matched. Carried so a track can be reported as
   *  the `ActScore` it was built from, rather than one fabricated downstream. */
  phraseMatch: number;
  slots: SlotCandidates;
  /** True for the one track currently painted on the stage. */
  leading: boolean;
};

export type Speculation = {
  text: string;
  final: boolean;
  tracks: Track[];
  leader: string | null;
  /** The stage changed act this tick — the visible cost of speculating. */
  switched: boolean;
  /** Acts that were alive last tick and are not now. */
  pruned: string[];
  /** Set once the transcript is final and the contract has taken over. */
  run: ActRun | null;
};

export type HeptaConfig = {
  /** How many candidate acts stay alive. Seven, for the obvious reason. */
  tongues?: number;
  /**
   * How far ahead a challenger must be before the stage switches to it.
   * Zero would make the interface flicker on every syllable.
   */
  switchMargin?: number;
  /** Below this an act is not worth a track. */
  floor?: number;
  routing?: RoutingConfig;
};

export const DEFAULT_TONGUES = 7;
export const DEFAULT_SWITCH_MARGIN = 0.2;
export const DEFAULT_FLOOR = 0.25;

export class Speculator {
  private readonly tongues: number;
  private readonly switchMargin: number;
  private readonly floor: number;
  private readonly routing: RoutingConfig;

  private run: ActRun | null = null;
  private leader: string | null = null;
  private alive: string[] = [];

  constructor(
    private readonly ui: AIUIC,
    private readonly local: LocalResolver,
    private readonly optionsFor: OptionsFor,
    config: HeptaConfig = {},
  ) {
    this.tongues = config.tongues ?? DEFAULT_TONGUES;
    this.switchMargin = config.switchMargin ?? DEFAULT_SWITCH_MARGIN;
    this.floor = config.floor ?? DEFAULT_FLOOR;
    this.routing = config.routing ?? DEFAULT_ROUTING;
  }

  get currentRun(): ActRun | null {
    return this.run;
  }

  get leaderName(): string | null {
    return this.leader;
  }

  /** Abandon everything. Used on a veto, or when the recognizer resets. */
  reset(): void {
    if (this.run && this.run.status !== 'settled') this.run.discard();
    this.run = null;
    this.leader = null;
    this.alive = [];
  }

  feed(interim: Interim, ctx: Ctx): Speculation {
    const text = interim.text.trim();
    const defs = this.ui.definitions;

    if (!text) {
      const pruned = this.alive;
      this.alive = [];
      return { text, final: interim.final, tracks: [], leader: null, switched: false, pruned, run: null };
    }

    // More speech after a sentence had ended: the act it produced goes back
    // to being speculative, so its hold stops and nothing commits mid-word.
    if (!interim.final && this.run) this.run.resumeSpeculation();

    const scores = this.local.scoreSync(text, defs, ctx, this.optionsFor);
    const kept = scores.filter((s) => s.score >= this.floor).slice(0, this.tongues);

    const tracks: Track[] = kept.map((s) => ({
      act: s.act,
      score: s.score,
      coverage: s.requiredCoverage,
      phraseMatch: s.phraseMatch,
      slots: this.local.fillSync(
        text,
        defs.find((d) => d.name === s.act)!,
        {},
        ctx,
        this.optionsFor,
      ),
      leading: false,
    }));

    const pruned = this.alive.filter((a) => !tracks.some((t) => t.act === a));
    this.alive = tracks.map((t) => t.act);

    const top = tracks[0];
    let switched = false;

    if (!top) {
      this.stopLeading();
      return { text, final: interim.final, tracks, leader: null, switched: false, pruned, run: null };
    }

    // Hold the current leader unless a challenger is clearly ahead: the stage
    // is a thing a person is looking at, so churning it has a real cost.
    //
    // That cost is a mid-sentence cost, and it stops existing the moment the
    // sentence does. On the final transcript there is no flicker left to
    // prevent — only one last chance to be right — so the margin is dropped
    // and the best track wins outright.
    //
    // Without this, a sentence that changes its mind cannot recover: "pay Maya
    // no actually give Maya the laundry" keeps the payment act to the end,
    // because the early words keep feeding the leader's score and the chore
    // act never gets clear enough to earn the switch. The person watched
    // themselves correct it and the stage did not follow.
    const current = tracks.find((t) => t.act === this.leader);
    const margin = interim.final ? 0 : this.switchMargin;
    const shouldSwitch = !current || top.score - current.score >= margin;

    if (shouldSwitch && top.act !== this.leader) {
      switched = true;
      this.leadWith(top, defs, ctx);
    } else if (this.run && current) {
      this.paint(current, ctx);
    }

    const leadTrack = tracks.find((t) => t.act === this.leader);
    if (leadTrack) leadTrack.leading = true;

    if (interim.final && this.run) {
      // The turning stops here. Everything the contract does — attention gate,
      // blast radius, HOLD — happens after this line, never before it.
      this.run.settleSpeculation();
    }

    return {
      text,
      final: interim.final,
      tracks,
      leader: this.leader,
      switched,
      pruned,
      run: interim.final ? this.run : null,
    };
  }

  private stopLeading(): void {
    if (this.run && this.run.status === 'speculating') this.run.discard();
    this.run = null;
    this.leader = null;
  }

  private leadWith(track: Track, defs: ActDef[], ctx: Ctx): void {
    this.stopLeading();
    this.leader = track.act;
    // Speculative from birth, not a moment after: start() evaluates before it
    // returns, and that first evaluate should already know the speaker has
    // not finished.
    this.run = this.ui.start(track.act, { speculative: true });
    this.paint(track, ctx);
  }

  /** Re-offer every slot from the transcript so far. Recognizers revise words. */
  private paint(track: Track, _ctx: Ctx): void {
    const run = this.run;
    if (!run || run.status === 'settled' || run.status === 'discarded') return;
    for (const slot of Object.keys(track.slots)) {
      const cands = track.slots[slot];
      if (cands && cands.length > 0) run.offer(slot, cands, 'spoken');
    }
  }
}

/** For a readout: the scores behind a tick, best first. */
export function explainTracks(spec: Speculation): Array<{ act: string; score: string; coverage: string; lead: boolean }> {
  return spec.tracks.map((t) => ({
    act: t.act,
    score: t.score.toFixed(2),
    coverage: (t.coverage * 100).toFixed(0) + '%',
    lead: t.leading,
  }));
}

export type { ActScore };
