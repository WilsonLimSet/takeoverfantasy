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

/** Minutes a game his last 3 and 5 must sit off his season average for a new role to count fully. */
const ROLE_SHIFT_3 = 4, ROLE_SHIFT_5 = 2;
/** Games of recent points per minute that count as much as the season's rate. */
const RECENT_RATE_K = 5;

/**
 * Minutes: his recent median blended with the season (one blowout or a foul-trouble night doesn't
 * swing it), unless his last 3 and last 5 games both sit well off his season: that's a new role
 * (a coach's call, a starter's injury) and the recent median counts fully. If an injured teammate
 * explains it, the teammate rule (value.ts `dependsOn`) takes it back after his return date.
 * Points per minute: the season's rate, moved toward his recent games' rate (a bigger role brings
 * more shots), half and half once he has 5 recent games.
 */
function fromSeason(cur: StatLine, recent: number[], recentFp: (number | undefined)[] = []) {
  let minutes = cur.min;
  if (recent.length >= 2) {
    const m5 = median(recent), m3 = median(recent.slice(0, 3));
    const moved = recent.length >= 3 && Math.abs(m3 - cur.min) >= ROLE_SHIFT_3 && Math.abs(m5 - cur.min) >= ROLE_SHIFT_5 && Math.sign(m3 - cur.min) === Math.sign(m5 - cur.min);
    minutes = moved ? m5 : 0.6 * m5 + 0.4 * cur.min;
  }
  const rate = (keep: (k: StatKey) => boolean) => fantasyPoints(part(cur, keep), SCORING) / cur.min;
  let relPts = minutes * rate((k) => RELIABLE.includes(k)), scoPts = minutes * rate((k) => !RELIABLE.includes(k));
  // Recent rate from the games he played (coach's DNPs have no minutes to rate).
  let fp = 0, mn = 0, n = 0;
  recent.forEach((m, i) => { const f = recentFp[i]; if (m > 0 && f !== undefined) { fp += f; mn += m; n++; } });
  const seasonRate = (relPts + scoPts) / (minutes || 1);
  if (n && mn >= 40 && seasonRate > 0) {
    const w = n / (n + RECENT_RATE_K);
    const scale = (w * (fp / mn) + (1 - w) * seasonRate) / seasonRate;
    relPts *= scale;
    scoPts *= scale;
  }
  return { minutes, relPts, scoPts, perGame: Math.max(0, relPts + scoPts) };
}

export function perGameCore(p: Player, recent: number[] = [], take?: Take, recentFp?: (number | undefined)[]): { minutes: number; relPts: number; scoPts: number; perGame: number } {
  const base = p.proj?.min ? p.proj : p.last?.min ? p.last : null;
  const prior = base && take && (take.kind === "boost" || take.kind === "fade") && hasRoleChange(take) ? applyMult(base, take) : base;
  const cur = p.cur?.gp && p.cur.min ? p.cur : null;
  const gp = cur?.gp ?? 0;
  // Once he has a few games this season, the preseason projection (and last season) stop counting:
  // Wilson ranks on what's happening now.
  if (cur && gp >= SEASON_GAMES) return fromSeason(cur, recent, recentFp);
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
