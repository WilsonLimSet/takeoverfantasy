import { fantasyPoints, PRESETS } from "./engine";
import { applyMult, hasRoleChange, type Take } from "./takes";
import type { Player, StatKey, StatLine } from "./types";

/**
 * Per-game fantasy points when he plays: minutes × points per minute (the core of src/lib/value.ts,
 * kept here with no data loading so the post code can use it too). Minutes follow recent games;
 * rebounds/assists/stocks/turnovers trust this season fast, scoring and shooting slowly. Rookies'
 * own games take over faster, since their projections are guesses.
 */

const SCORING = PRESETS[0].league.scoring;
/** The settled part of a stat line. */
const RELIABLE: StatKey[] = ["reb", "oreb", "dreb", "ast", "stl", "blk", "tov", "dd", "td"];

export const isRookie = (p: Player) => p.bio?.years === 0 || (p.bio?.years == null && !p.last && (p.age ?? 22) <= 22);
const blend = (cur: number, prior: number, w: number) => w * cur + (1 - w) * prior;
const part = (line: StatLine, keep: (k: StatKey) => boolean) =>
  Object.fromEntries(Object.entries(line).map(([k, v]) => [k, k === "gp" || keep(k as StatKey) ? v : 0])) as StatLine;
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

/**
 * recent: minutes in his last few games played, newest first (optional). take: the AI's read of
 * his news (src/lib/autoTakes.ts); a role change (trade, starter's injury, rotation change) adjusts
 * the starting expectation, and his own games take over from it as they pile up.
 */
/** Games this season after which the preseason projection no longer counts. */
export const SEASON_GAMES = 3;

/** Minutes from recent games (median, so one blowout doesn't swing it) and the season; points per minute from the season. */
function fromSeason(cur: StatLine, recent: number[]) {
  const minutes = recent.length >= 2 ? 0.6 * median(recent) + 0.4 * cur.min : cur.min;
  const rate = (keep: (k: StatKey) => boolean) => fantasyPoints(part(cur, keep), SCORING) / cur.min;
  const relPts = minutes * rate((k) => RELIABLE.includes(k)), scoPts = minutes * rate((k) => !RELIABLE.includes(k));
  return { minutes, relPts, scoPts, perGame: Math.max(0, relPts + scoPts) };
}

export function perGameCore(p: Player, recent: number[] = [], take?: Take): { minutes: number; relPts: number; scoPts: number; perGame: number } {
  const base = p.proj?.min ? p.proj : p.last?.min ? p.last : null;
  const prior = base && take && (take.kind === "boost" || take.kind === "fade") && hasRoleChange(take) ? applyMult(base, take) : base;
  const cur = p.cur?.gp && p.cur.min ? p.cur : null;
  const gp = cur?.gp ?? 0;
  // Once he has a few games this season, the preseason projection (and last season) stop counting:
  // Wilson ranks on what's happening now.
  if (cur && gp >= SEASON_GAMES) return fromSeason(cur, recent);
  const [kMin, kRel, kScore] = isRookie(p) ? [1, 2, 5] : [3, 3, 10];

  // Minutes: recent games (median, so one blowout doesn't swing it) and the season so far, then
  // the prior until games pile up.
  const now = cur ? (recent.length >= 2 ? 0.6 * median(recent) + 0.4 * cur.min : cur.min) : prior?.min ?? 0;
  const minutes = prior ? blend(now, prior.min, gp / (gp + kMin)) : now;

  const rate = (line: StatLine | null, keep: (k: StatKey) => boolean) => (line?.min ? fantasyPoints(part(line, keep), SCORING) / line.min : 0);
  const isRel = (k: StatKey) => RELIABLE.includes(k), isScore = (k: StatKey) => !RELIABLE.includes(k);
  const relPM = cur && prior ? blend(rate(cur, isRel), rate(prior, isRel), gp / (gp + kRel)) : rate(cur ?? prior, isRel);
  const scoPM = cur && prior ? blend(rate(cur, isScore), rate(prior, isScore), gp / (gp + kScore)) : rate(cur ?? prior, isScore);
  const relPts = minutes * relPM, scoPts = minutes * scoPM;
  // No minutes data at all (rare): fall back to the projection's per-game points.
  if (!minutes && (p.proj ?? p.last)) return { minutes: 0, relPts: 0, scoPts: 0, perGame: fantasyPoints((p.proj ?? p.last)!, SCORING) };
  return { minutes, relPts, scoPts, perGame: Math.max(0, relPts + scoPts) };
}
