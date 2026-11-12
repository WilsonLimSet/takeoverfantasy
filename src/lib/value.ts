import { getPlayers } from "./data";
import { loadHealth, type HealthProfile } from "./healthHistory";
import { RECIPIENT_MIN, shareMinutes, type RotationPlayer } from "./inseason/opportunity";
import { injuryReport, type InjuryReportEntry } from "./inseason/stash";
import { kvStore } from "./inseason/storage";
import { easternDate, teamTips } from "./social";
import { loadTakes, normName, type Take } from "./takes";
import type { Player } from "./types";
import type { PlayerRotation } from "@/types";
import { isRookie, perGameCore } from "./valueCore";

/**
 * How Takeover values a player. Expected fantasy points = chance he plays × minutes × points per
 * minute, summed over the games that matter:
 *  - window: a stretch like "the next 2 days" or "rest of this week". Only whether he plays those
 *    games counts (current injury status), not long-term durability.
 *  - rest of season: durability counts too (games missed last season, age, current injury).
 * Minutes follow recent games (median of the last few, so one blowout doesn't swing it) and flag
 * roles that only exist while an injured teammate is out. Points per minute is split in two:
 * rebounds, assists, steals, blocks and turnovers settle fast, so this season's rate takes over
 * quickly; scoring and shooting swing with luck, so it leans on the projection longer and drives
 * the floor/ceiling spread. Players on bad teams get no penalty: empty stats still count.
 */

const OUT = new Set(["OUT", "INJURY_RESERVE", "SUSPENSION"]);
const DAY = 864e5;
const COACH = /coach/i;

export interface ValueContext {
  now: number;
  players: Player[];
  byId: Map<number, Player>;
  injuries: Map<number, InjuryReportEntry>;
  tips: Map<string, number[]>;
  /** Minutes in each recent game played, newest first (from the nightly box-score snapshots). */
  recentMin: Map<number, number[]>;
  /** Fantasy points (ESPN standard) in the same games, lined up with recentMin (undefined when unsaved). */
  recentFp: Map<number, (number | undefined)[]>;
  /** The same snapshots night by night, newest first, for "with him vs without him" splits. */
  nights: { date: string; min: Record<string, number> }[];
  /** Expected minute shares per injured player (filled as needed). */
  shares?: Map<number, Map<number, number>>;
  /** Injury history from game logs (src/lib/healthHistory.ts), by player id. */
  health: Record<string, HealthProfile>;
  /** The AI's role reads from player news (src/lib/autoTakes.ts), by normalized name. */
  takes: Map<string, Take>;
}

export async function valueContext(now = Date.now()): Promise<ValueContext> {
  const kv = kvStore();
  const nights = Array.from({ length: 10 }, (_, i) => easternDate(now - (i + 1) * DAY));
  const [{ players }, injuries, tips, health, takeSet, snaps, dnps, fpts] = await Promise.all([
    getPlayers(),
    injuryReport().catch(() => new Map<number, InjuryReportEntry>()),
    teamTips().catch(() => new Map<string, number[]>()),
    loadHealth(),
    loadTakes(),
    Promise.all(nights.map((d) => kv.get<Record<string, number>>(`social:minutes:${d}`).catch(() => null))),
    Promise.all(nights.map((d) => kv.get<Record<string, string>>(`social:dnp:${d}`).catch(() => null))),
    Promise.all(nights.map((d) => kv.get<Record<string, number>>(`social:fpts:${d}`).catch(() => null))),
  ]);
  // A coach's-decision DNP is a 0-minute game: the rotation moved past him. Injury and rest DNPs
  // aren't counted at all.
  const recentMin = new Map<number, number[]>();
  const recentFp = new Map<number, (number | undefined)[]>();
  snaps.forEach((snap, i) => {
    const night = new Map<number, number>();
    for (const [id, min] of Object.entries(snap ?? {})) if (min > 0) night.set(Number(id), min);
    for (const [id, why] of Object.entries(dnps[i] ?? {})) if (COACH.test(why) && !night.has(Number(id))) night.set(Number(id), 0);
    for (const [id, min] of night) {
      recentMin.set(id, [...(recentMin.get(id) ?? []), min]);
      recentFp.set(id, [...(recentFp.get(id) ?? []), min > 0 ? fpts[i]?.[id] : undefined]);
    }
  });
  const nightList = nights.map((date, i) => ({ date, min: snaps[i] ?? {} })).filter((n) => Object.keys(n.min).length);
  return { now, players, byId: new Map(players.map((p) => [p.id, p])), injuries, tips, recentMin, nights: nightList, health, takes: takeSet.index, recentFp };
}

export interface PlayerValue {
  id: number;
  /** Expected fantasy points in a game he plays, now. */
  perGame: number;
  /** A bad night and a good night (about one standard deviation). */
  floor: number;
  ceiling: number;
  minutes: number;
  /** Share of his points from rebounds/assists/stocks (steadier than scoring). */
  steady: number;
  status: string;
  returnDate?: string;
  /** His minutes are up only while a teammate is out: the first of those teammates back. */
  temporary?: { until: string; because: string; minutesAfter: number };
  /** Every injured teammate whose absence gives him minutes, soonest back first. */
  dependsOn: Dependence[];
  /** A role change the AI read in his news, and how much it still moves his value. */
  news?: { headline: string; date: string; factor: number };
  /** In the window asked for: games, and expected points counting only current injury status. */
  games: number;
  window: number;
  /** Rest of season: expected points per team game left, durability included. */
  ros: number;
  /** From game logs: durable, one-off (a long injury, healthy otherwise), in-and-out (sits often). */
  health: HealthProfile["label"];
  /** Share of games he plays when not on a long injury. */
  durability: number;
}


function statusOf(p: Player, ctx: ValueContext): { status: string; returnDate?: string } {
  const r = ctx.injuries.get(p.id);
  if (!r) return { status: OUT.has(p.injury) ? "OUT" : p.injury === "DAY_TO_DAY" ? "DAY_TO_DAY" : "ACTIVE" };
  const s = r.status.toLowerCase();
  return { status: s.includes("out") || s.includes("injured") ? "OUT" : s.includes("day") || s.includes("question") ? "DAY_TO_DAY" : "ACTIVE", returnDate: r.returnDate };
}

/** Chance he plays a game at time t, from his current status only. */
function playChance(t: number, st: { status: string; returnDate?: string }, first: boolean, now: number): number {
  if (st.status === "OUT") {
    if (!st.returnDate) return t - now < 7 * DAY ? 0 : 0.5;
    return easternDate(t) < st.returnDate ? 0 : 0.85;
  }
  // ESPN's day-to-day can mean out until a date (a sprain): not before it.
  if (st.status === "DAY_TO_DAY") return st.returnDate && easternDate(t) < st.returnDate ? 0 : first ? 0.6 : 0.9;
  return 0.97;
}


/**
 * Long-term durability: share of games he plays when not on a known injury. From his game logs
 * when we have them: games played with one-off long injuries taken out, so a player who missed 40
 * games once isn't marked fragile, while one who sits every other week is. Otherwise from last
 * season's games, counted only for rotation players (a bench player's missed games are mostly
 * coach's decisions).
 */
function durability(p: Player, h?: HealthProfile): number {
  const age = (p.age ?? 0) >= 33 ? 0.04 : (p.age ?? 0) >= 30 ? 0.02 : 0;
  if (h && h.label !== "unknown") return Math.min(0.97, Math.max(0.55, h.baseline - age));
  const rotation = (p.last?.gp ?? 0) > 0 && (p.last?.min ?? 0) >= 20;
  // No games last season: fine for a rookie, a risk for a veteran (usually a long injury).
  const lastRate = rotation ? Math.min(1, p.last!.gp / 72) : !p.last?.gp && !isRookie(p) && (p.bio?.years ?? 0) >= 2 ? 0.6 : 0.88;
  return Math.min(0.95, Math.max(0.7, 0.4 * lastRate + 0.6 * 0.88 - age));
}

export interface Dependence {
  id: number;
  name: string;
  /** First US date he's expected back. */
  until: string;
  /** Minutes a game this player gets from the absence. */
  minutes: number;
  /** From games with and without him, the expected split, or both. */
  basis: "games" | "estimate" | "both";
}

/** Regulars this short of minutes don't leave a gap worth tracking. */
const REGULAR_MIN = 18;
/** Absences further out than this are a different season's problem. */
const DEPENDENCE_DAYS = 75;
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

/** The minutes each healthy teammate is expected to pick up while q is out (#47's position-based split). */
function expectedShares(q: Player, ctx: ValueContext): Map<number, number> {
  ctx.shares ??= new Map();
  const hit = ctx.shares.get(q.id);
  if (hit) return hit;
  const rot = (x: Player): RotationPlayer => {
    const core = perGameCore(x, (ctx.recentMin.get(x.id) ?? []).slice(0, 5), undefined, ctx.recentFp.get(x.id)?.slice(0, 5));
    const gp = x.cur?.gp ?? 0;
    return { id: x.id, positions: x.pos, minutes: core.minutes, fppg: core.perGame, minutesWeight: gp / (gp + 3), gamesPlayed: gp };
  };
  const healthy = ctx.players
    .filter((x) => x.team === q.team && x.id !== q.id && statusOf(x, ctx).status !== "OUT")
    .map(rot)
    .filter((x) => x.minutes >= RECIPIENT_MIN);
  // Counted as a fresh absence: how much of it is already in his minutes is worked out per player.
  const out = new Map(shareMinutes(rot(q), healthy, 0).map((x) => [x.id, x.minutes]));
  ctx.shares.set(q.id, out);
  return out;
}

/**
 * Injured teammates this player's minutes lean on: regulars out with a return date. The gain is
 * measured from recent games with and without the teammate when there are both, blended with the
 * expected split while those samples are thin.
 */
function dependence(p: Player, ctx: ValueContext): Dependence[] {
  const today = easternDate(ctx.now);
  const deps: Dependence[] = [];
  for (const q of ctx.players) {
    if (q.team !== p.team || q.id === p.id || q.team === "FA") continue;
    const r = ctx.injuries.get(q.id);
    if (!r?.returnDate || !/out|injur|suspen/i.test(r.status) || r.returnDate <= today || Date.parse(r.returnDate) - ctx.now > DEPENDENCE_DAYS * DAY) continue;
    if (Math.max(q.last?.min ?? 0, perGameCore(q).minutes) < REGULAR_MIN) continue;
    const share = expectedShares(q, ctx).get(p.id) ?? 0;
    const withQ: number[] = [], without: number[] = [];
    for (const n of ctx.nights) {
      const pm = n.min[p.id];
      if (!(pm > 0)) continue;
      (n.min[q.id] > 0 ? withQ : without).push(pm);
    }
    let gain = share, basis: Dependence["basis"] = "estimate";
    if (withQ.length && without.length) {
      const seen = mean(without) - mean(withQ), w = Math.min(1, Math.min(withQ.length, without.length) / 3);
      gain = w * seen + (1 - w) * share;
      basis = w === 1 ? "games" : "both";
    }
    gain = Math.min(14, Math.max(0, gain));
    if (gain >= 3) deps.push({ id: q.id, name: q.name, until: r.returnDate, minutes: Math.round(gain * 10) / 10, basis });
  }
  return deps.sort((a, b) => a.until.localeCompare(b.until));
}

/** Share of his recent games each injured teammate already missed: that part is in his minutes now. */
function absentShareOf(p: Player, ctx: ValueContext) {
  const recentNights = ctx.nights.filter((n) => n.min[p.id] > 0).slice(0, 5);
  return (d: Dependence) => (recentNights.length ? recentNights.filter((n) => !(n.min[d.id] > 0)).length / recentNights.length : 0);
}

/**
 * His role from the box scores, for the in-season moves engine: expected minutes now (recent games,
 * coach's-decision DNPs as 0) and the minutes that lean on injured teammates. The engine keeps its
 * own points per minute, in the league's scoring.
 */
export function rotationOf(p: Player, ctx: ValueContext): PlayerRotation {
  const recent = (ctx.recentMin.get(p.id) ?? []).slice(0, 5), fp = ctx.recentFp.get(p.id)?.slice(0, 5);
  const take = ctx.takes.get(normName(p.name));
  const core = perGameCore(p, recent, take, fp);
  const { minutes } = core;
  // How far his recent points per minute move him off his season rate (a bigger role, more shots).
  const plain = perGameCore(p, recent, take).perGame;
  const rateScale = plain > 0 ? Math.round((core.perGame / plain) * 100) / 100 : 1;
  const absentShare = absentShareOf(p, ctx);
  const r1 = (n: number) => Math.round(n * 10) / 10;
  return {
    minutes: r1(minutes),
    rateScale,
    played: recent.filter((m) => m > 0),
    deps: dependence(p, ctx).map((d) => ({ id: d.id, name: d.name, until: d.until, minutes: d.minutes, absentShare: Math.round(absentShare(d) * 100) / 100 })),
  };
}

let shared: { at: number; ctx: Promise<ValueContext> } | null = null;
/** One value context reused across league refreshes for a few minutes (the cron refreshes every league). */
export function sharedValueContext(maxAgeMs = 10 * 60 * 1000): Promise<ValueContext> {
  if (!shared || Date.now() - shared.at > maxAgeMs) {
    const ctx = valueContext();
    shared = { at: Date.now(), ctx };
    ctx.catch(() => { shared = null; });
  }
  return shared.ctx;
}

export function valuePlayer(p: Player, ctx: ValueContext, window?: { from: string; to: string }): PlayerValue {
  const st = statusOf(p, ctx);
  const recent = (ctx.recentMin.get(p.id) ?? []).slice(0, 5);
  const take = ctx.takes.get(normName(p.name));
  const fp = ctx.recentFp.get(p.id)?.slice(0, 5);
  const { minutes, relPts, scoPts, perGame } = perGameCore(p, recent, take, fp);
  // How much the AI's role read still moves him (it fades as his own games pile up).
  const plain = take ? perGameCore(p, recent, undefined, fp).perGame : perGame;
  const news = take && plain ? { headline: take.headline, date: take.notes[0]?.date ?? take.updated, factor: perGame / plain } : null;
  const sd = Math.sqrt((0.45 * Math.max(0, scoPts)) ** 2 + (0.25 * Math.max(0, relPts)) ** 2);

  // Minutes that lean on injured teammates. His minutes estimate already contains the part he
  // played without them recently; until they're back he gets the rest too, and after they
  // return he loses it all.
  const dependsOn = dependence(p, ctx);
  const absentShare = absentShareOf(p, ctx);
  const minutesOn = (date: string) => Math.max(0, minutes + dependsOn.reduce((m, d) => m + (date < d.until ? d.minutes * (1 - absentShare(d)) : -d.minutes * absentShare(d)), 0));
  const perGameAt = (t: number) => (minutes ? perGame * (minutesOn(easternDate(t)) / minutes) : perGame);
  const first = dependsOn[0];
  const temporary: PlayerValue["temporary"] = first
    ? { until: first.until, because: first.name, minutesAfter: Math.round(minutesOn(first.until) * 10) / 10 }
    : undefined;

  const tips = (ctx.tips.get(p.team) ?? []).filter((t) => t > ctx.now);
  const inWindow = window ? tips.filter((t) => easternDate(t) >= window.from && easternDate(t) <= window.to) : [];
  const windowPts = inWindow.reduce((s, t, i) => s + playChance(t, st, i === 0, ctx.now) * perGameAt(t), 0);
  const dur = durability(p, ctx.health[p.id]);
  const rosPts = tips.reduce((s, t, i) => s + (st.status === "ACTIVE" ? dur : Math.min(dur, playChance(t, st, i === 0, ctx.now))) * perGameAt(t), 0);

  const r1 = (n: number) => Math.round(n * 10) / 10;
  return {
    id: p.id, perGame: r1(perGame), floor: r1(Math.max(0, perGame - sd)), ceiling: r1(perGame + sd), minutes: r1(minutes),
    steady: perGame ? Math.round((relPts / perGame) * 100) / 100 : 0, status: st.status, returnDate: st.returnDate, temporary, dependsOn,
    ...(news && Math.abs(news.factor - 1) >= 0.02 ? { news: { ...news, factor: Math.round(news.factor * 100) / 100 } } : {}),
    games: inWindow.length, window: r1(windowPts), ros: r1(tips.length ? rosPts / tips.length : 0),
    health: ctx.health[p.id]?.label ?? "unknown", durability: Math.round(dur * 100) / 100,
  };
}

/* ---------------- Keeping score ---------------- */

type Pred = Record<string, [perGame: number, steady: number]>;
interface PredictionScore { date: string; n: number; mae: number; bias: number; steady: { n: number; mae: number; bias: number }; volatile: { n: number; mae: number; bias: number } }

/** Save today's per-game values (before the games) for players anyone might roster. */
export async function recordPredictions(date: string, ctx?: ValueContext): Promise<number> {
  const c = ctx ?? (await valueContext());
  const pred: Pred = {};
  for (const p of c.players) {
    if (p.team === "FA" || (p.pctOwned ?? 0) < 5) continue;
    const v = valuePlayer(p, c);
    if (v.status !== "OUT") pred[p.id] = [v.perGame, v.steady];
  }
  await kvStore().set(`value:pred:${date}`, pred);
  return Object.keys(pred).length;
}

/**
 * Compare a night's predictions with what players scored (10+ minutes played), overall and split
 * by steady players (most points from rebounds/assists/stocks) vs scorers. Bias > 0 means we
 * valued them too high.
 */
export async function scorePredictions(night: string, lines: { id: number; fpts: number; min: number }[]): Promise<PredictionScore | null> {
  const kv = kvStore();
  const pred = await kv.get<Pred>(`value:pred:${night}`);
  if (!pred) return null;
  const errs = lines.filter((l) => l.min >= 10 && pred[l.id]).map((l) => ({ e: pred[l.id][0] - l.fpts, steady: pred[l.id][1] >= 0.55 }));
  if (!errs.length) return null;
  const sum = (xs: typeof errs) => {
    const r1 = (n: number) => Math.round(n * 10) / 10;
    return { n: xs.length, mae: r1(xs.reduce((s, x) => s + Math.abs(x.e), 0) / (xs.length || 1)), bias: r1(xs.reduce((s, x) => s + x.e, 0) / (xs.length || 1)) };
  };
  const score: PredictionScore = { date: night, ...sum(errs), steady: sum(errs.filter((x) => x.steady)), volatile: sum(errs.filter((x) => !x.steady)) };
  await kv.set(`value:err:${night}`, score);
  return score;
}
