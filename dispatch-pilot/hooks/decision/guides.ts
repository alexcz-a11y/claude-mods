// How each decision model's answers are read: the guide its maker publishes, not ours (ADR 0014 for Jev and pplx, ADR 0017
// for d1-ultra). The one place the bars of a yes/no, the rule for an unsure effort answer and the way an agent's model is
// chosen are written; core/setup.ts BACKEND_DEFAULTS gives each decision model its guide, and every rule reads it from there.
//
//   TypeSafe (Jev, and pplx, which answers as Jev does)
//     yes/no     yes from 0.7, no up to 0.3, the band between ("A good starting point is 0.7 for yes and 0.3 for no")
//     effort     the Score's position rounded; one level up when it is two-peaked ("The Score's position can get pulled toward
//                the middle and hide two-peaked answers")
//     agents     yes/no questions about the brief, a model table in code ("Judgments from Jev, decisions in code")
//   Liquid (d1-ultra and d1.1; docs.liquid.ai/guides/decision-model-guide and its decision-model skill)
//     yes/no     yes above 0.8, no below 0.2, the band between (the guide's binary decision: `if p > 0.8: action = "block"
//                elif p < 0.2: action = "allow" else: action = "human_review"`)
//     effort     the Score's position rounded, as it stands (the guide gives no rule for an unsure Score; until 0.11.0 we
//                took one level up below a confidence of 0.5, the router's bar, and measured it 13 to 18 points worse on
//                effort-submit: ADR 0022)
//     agents     one Choice of a model tier, the strongest model allowed when its confidence is below 0.5 (the guide's routing:
//                `if confidence < 0.5: selected = "powerful"`)
//
// The skills (ADR 0018) are suggested as TypeSafe's skill suggestion cookbook does it, whichever model decides; only the
// bars are each guide's: TypeSafe's are the cookbook's (ACTION_THRESHOLD 0.30, NAMED_THRESHOLD 0.50, FITS_THRESHOLD 0.30;
// ADR 0021), Liquid's its guide's binary decision (a mean, or the `named` answer, below 0.2 reads as a clear no) and its
// reranking example (`[c for c in scored_chunks if c["score"] > 0.5]`, "keep everything above 0.5").
//
// Pure: no imports. Neither guide's numbers were tuned on our evals (ADR 0014, ADR 0017).

/** The bars a yes/no answer (a Noul) is held to. `inclusive`: a probability on a bar counts (TypeSafe's ≥ 0.7, ≤ 0.3); else it must pass it (Liquid's > 0.8, < 0.2). */
export type NoulBars = { yes: number; no: number; inclusive: boolean }

/**
 * When the effort answer counts as unsure, and the base goes one level up. `two-peaked`: a level two or more above the base has
 * at least `secondPeak` (TypeSafe). `none`: the answer is read as it stands (Liquid, whose guide gives no rule for an unsure
 * Score; its "confidence below 0.5" is its router's, and stays there: `routeFallbackBelow`).
 */
export type ScoreUnsure = { rule: 'two-peaked'; secondPeak: number } | { rule: 'none' }

/**
 * The skills' bars (ADR 0018, ADR 0021): no skill is suggested when the mean of the three questions on whether the message
 * wants an action is below `gateBelow` and the answer on whether it names a method a skill owns (`named`) is below
 * `namedBelow` (the cookbook's `needs_skill`: either reason is enough; a value on a bar counts); the winner is suggested when
 * the best "does it do this" answer of the shortlist reaches `fits` (`fitsInclusive`: a value on the bar counts, TypeSafe's ≥;
 * else it must pass it, Liquid's >). find_skill returns every candidate that reaches `fits`.
 */
export type SkillBars = { gateBelow: number; namedBelow: number; fits: number; fitsInclusive: boolean }

/** One decision model's way of reading answers. */
export type Guide = {
  /** Whose guide it is: the steps and the card say so. */
  name: 'typesafe' | 'liquid'
  noul: NoulBars
  scoreUnsure: ScoreUnsure
  skills: SkillBars
  /**
   * How a dispatched agent's model is chosen: `table`, yes/no questions about the brief and the model table (ADR 0015);
   * `route`, one Choice of a model tier, falling back to the strongest model allowed below `routeFallbackBelow` (ADR 0017).
   */
  agentModel: 'table' | 'route'
  /** The route's confidence under which the strongest model allowed is taken; unused with the table. */
  routeFallbackBelow: number
}

/** TypeSafe's starting values (docs.typesafe.ai; ADR 0014): Jev's, and pplx's. */
export const TYPESAFE_GUIDE: Guide = {
  name: 'typesafe',
  noul: { yes: 0.7, no: 0.3, inclusive: true },
  scoreUnsure: { rule: 'two-peaked', secondPeak: 0.3 },
  skills: { gateBelow: 0.3, namedBelow: 0.5, fits: 0.3, fitsInclusive: true },
  agentModel: 'table',
  routeFallbackBelow: 0.5,
}

/** Liquid's (docs.liquid.ai/guides/decision-model-guide; ADR 0017): d1-ultra's and d1.1's. */
export const LIQUID_GUIDE: Guide = {
  name: 'liquid',
  noul: { yes: 0.8, no: 0.2, inclusive: false },
  scoreUnsure: { rule: 'none' },
  skills: { gateBelow: 0.2, namedBelow: 0.2, fits: 0.5, fitsInclusive: false },
  agentModel: 'route',
  routeFallbackBelow: 0.5,
}

/** The yes bar as the card and the log write it: `≥ 70%` (TypeSafe) or `> 80%` (Liquid). */
export function yesBar(bars: NoulBars, percent: (p: number) => string): string {
  return `${bars.inclusive ? '≥' : '>'} ${percent(bars.yes)}`
}

/** The no bar as the card and the log write it: `≤ 30%` (TypeSafe) or `< 20%` (Liquid). */
export function noBar(bars: NoulBars, percent: (p: number) => string): string {
  return `${bars.inclusive ? '≤' : '<'} ${percent(bars.no)}`
}

/** Whether a skill's "does it do this" answer reaches the guide's bar. */
export function fitsBar(bars: SkillBars, fit: number): boolean {
  return bars.fitsInclusive ? fit >= bars.fits : fit > bars.fits
}

/** The fits bar as the log writes it: `≥ 0.30` (TypeSafe) or `> 0.50` (Liquid). */
export function fitsBarText(bars: SkillBars): string {
  return `${bars.fitsInclusive ? '≥' : '>'} ${bars.fits.toFixed(2)}`
}

/**
 * How an effort answer asked while a loop runs moves the loop's level (ADR 0020). The answer is read on the side of the
 * current level that matters, never by its confidence alone (TypeSafe, Confidence: "When a decision depends on which side of
 * a level boundary the answer falls, add up the probabilities of the levels on the side that matters"; "Check confidence
 * first when your code needs to know whether a Score answer is settled at all"), and the two directions have their own bars
 * ("Riskier actions get higher thresholds"): lowering a level too far costs rework, so it needs more than raising does.
 *
 *   up        the share of probability on the levels above the current one that a raise needs
 *   down      the share on the levels below it that a lowering needs
 *   settled   the answer's confidence under which nothing is lowered
 *   inclusive a value on a bar counts (TypeSafe's ≥); else it must pass it (Liquid's >)
 *
 * The level the answer reads at is the guide's own (`scoreUnsure`): TypeSafe's two peaks, a share two levels up being a
 * reading and not a doubt; Liquid's as it stands.
 */
export type MidrunBars = { up: number; down: number; settled: number; inclusive: boolean }

/**
 * Each guide's bars for it, by the guide's name; none tuned on our evals.
 *
 *   TypeSafe  up 0.3: Routing by confidence acts on the far side of a Score at that share (`blocked =
 *             severity.probabilities[3] + severity.probabilities[4]`, `if blocked >= 0.3`). down 0.7: a yes ("A good starting
 *             point is 0.7 for yes"). settled 0.5: the same pattern's `if severity.confidence < 0.5` goes to a person.
 *   Liquid    up 0.2 and down 0.8: its guide's binary decision (`if p > 0.8 ... elif p < 0.2`: what is not a clear no, and
 *             a clear yes). settled 0.5: its router's `if confidence < 0.5`.
 */
export const MIDRUN_BARS: Readonly<Record<Guide['name'], MidrunBars>> = {
  typesafe: { up: 0.3, down: 0.7, settled: 0.5, inclusive: true },
  liquid: { up: 0.2, down: 0.8, settled: 0.5, inclusive: false },
}
