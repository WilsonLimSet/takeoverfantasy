import { League, Slot, Valued, Cat, rosterSize } from "./engine";
import { Pos } from "./types";

export interface DraftState {
  mySlot: number; // 1-based
  rounds: number;
  picks: number[]; // player ids in pick order
}

/** Draft order: snake, the same order every round, or snake with rounds 2 and 3 both reversed. */
export type DraftSequence = "snake" | "linear" | "3rr";

/** Team index (0-based) on the clock for pick k (0-based). */
export function teamForPick(k: number, teams: number, seq: DraftSequence = "snake") {
  const round = Math.floor(k / teams);
  const i = k % teams;
  const reversed = seq === "linear" ? false : seq === "3rr" ? round === 1 || (round >= 2 && round % 2 === 0) : round % 2 === 1;
  return reversed ? teams - 1 - i : i;
}

/** Upcoming pick numbers (0-based) for team `t`, starting at or after `from`. */
export function nextPicksFor(t: number, teams: number, rounds: number, from: number, count = 3, seq: DraftSequence = "snake") {
  const out: number[] = [];
  for (let k = from; k < teams * rounds && out.length < count; k++) if (teamForPick(k, teams, seq) === t) out.push(k);
  return out;
}

const SLOT_ELIG: Record<Slot, Pos[]> = {
  PG: ["PG"], SG: ["SG"], SF: ["SF"], PF: ["PF"], C: ["C"],
  G: ["PG", "SG"], F: ["SF", "PF"], UT: ["PG", "SG", "SF", "PF", "C"],
};

/** Greedy assignment of a roster to starting slots; returns filled slots and open ones. */
export function fillLineup(roster: Valued[], league: League) {
  const open: Slot[] = [];
  for (const [s, n] of Object.entries(league.slots) as [Slot, number][]) for (let i = 0; i < n; i++) open.push(s);
  // most restrictive slots first
  const order: Slot[] = ["C", "PG", "SG", "SF", "PF", "G", "F", "UT"];
  open.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const filled: { slot: Slot; v: Valued | null }[] = open.map((slot) => ({ slot, v: null }));
  const bench: Valued[] = [];
  const sorted = [...roster].sort((a, b) => b.vorp - a.vorp);
  // assign players with fewest eligible positions first so flexibility is preserved
  sorted.sort((a, b) => a.p.pos.length - b.p.pos.length || b.vorp - a.vorp);
  for (const v of sorted) {
    const spot = filled.find((f) => !f.v && SLOT_ELIG[f.slot].some((p) => v.p.pos.includes(p)));
    if (spot) spot.v = v; else bench.push(v);
  }
  return { filled, bench };
}

export function teamCatProfile(roster: Valued[], cats: Cat[]) {
  const prof: Partial<Record<Cat, number>> = {};
  for (const c of cats) prof[c] = roster.reduce((s, v) => s + (v.z[c] ?? 0), 0);
  return prof;
}

/** From this share of the rounds on, recommendations favor ceiling over expected value. */
export const LATE_ROUND_SHARE = 0.65;

interface Rec {
  v: Valued;
  score: number;
  reasons: string[];
  canWait: boolean;
  goingSoon: boolean;
}

/** Rank available players for *my* next pick. */
export function recommend(
  avail: Valued[], myRoster: Valued[], league: League, currentPick: number, myNextPicks: number[],
  stars: ReadonlySet<number> = new Set(),
  avoid: ReadonlySet<number> = new Set(),
): Rec[] {
  const { filled } = fillLineup(myRoster, league);
  const openSlots = filled.filter((f) => !f.v).map((f) => f.slot);
  const activeCats = league.cats.filter((c) => !league.punts.includes(c));
  const prof = teamCatProfile(myRoster, activeCats);
  const weakest = [...activeCats].sort((a, b) => (prof[a] ?? 0) - (prof[b] ?? 0)).slice(0, 3);
  const topV = avail[0]?.vorp || 1;
  const pickAfterNext = myNextPicks[1] ?? Infinity;
  // Late in the draft, swing for upside: a bust gets cut for a waiver pickup, a hit wins your league.
  const round = Math.floor(currentPick / league.teams) + 1;
  const late = round > Math.round(rosterSize(league) * LATE_ROUND_SHARE);

  // Your starred targets are always considered, however far down the board.
  // Your do-not-draft list is never recommended.
  const ok = avoid.size ? avail.filter((v) => !avoid.has(v.p.id)) : avail;
  const pool = [...ok.slice(0, 60), ...ok.slice(60).filter((v) => stars.has(v.p.id))];
  return pool.map((v) => {
    const reasons: string[] = [];
    let score = (late ? 0.4 * v.vorp + 0.6 * v.ceiling.vorp : v.vorp) / Math.abs(topV);
    if (late && v.ceiling.rank < v.rank - 15) reasons.push(`Upside swing: a top-${v.ceiling.rank} player if it hits`);
    // A starting spot (not UTIL) in your lineup that is still empty and he can play.
    const fills = openSlots.find((s) => s !== "UT" && SLOT_ELIG[s].some((p) => v.p.pos.includes(p)));
    if (fills && myRoster.length >= 4) { score += 0.04; reasons.push(`Fills your empty ${fills} spot`); }
    if (league.format === "cats" && myRoster.length >= 3) {
      const helps = weakest.filter((c) => (v.z[c] ?? 0) > 0.8);
      if (helps.length) { score += 0.03 * helps.length; reasons.push(`Helps ${helps.map((c) => c.toUpperCase()).join("/")}`); }
    }
    const adp = v.p.adp ?? v.rank;
    const myPick = myNextPicks[0] ?? currentPick;
    const myTurn = myPick === currentPick;
    // market says he'll still be there at my pick after this one
    const canWait = adp - 1 > pickAfterNext + 2;
    // market says he's gone before my upcoming pick
    const goingSoon = !myTurn ? adp - 1 < myPick - 2 : adp - 1 <= currentPick + 3;
    if (canWait) { score -= 0.06; reasons.push(`Can wait: usually goes around pick ${adp.toFixed(0)}`); }
    if (goingSoon && !myTurn) { score -= 0.05; reasons.push("Probably gone before your pick"); }
    else if (goingSoon) reasons.push(`Won't last: usually goes around pick ${adp.toFixed(0)}`);
    if (stars.has(v.p.id)) {
      // A target you won't see again gets a nudge; one who will last can wait.
      if (!canWait) { score += 0.05; reasons.unshift("Your target"); }
      else reasons.unshift("Your target (can wait)");
    }
    if (v.p.injury !== "ACTIVE") { score -= 0.03; reasons.push(v.p.injury.replace(/_/g, " ").toLowerCase()); }
    return { v, score, reasons, canWait, goingSoon };
  }).sort((a, b) => b.score - a.score);
}
