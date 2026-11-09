import { fantasyPoints, PRESETS } from "./engine";
import { kvStore } from "./inseason/storage";
import { easternDate } from "./social";
import type { Player } from "./types";
import { valueContext, valuePlayer, type ValueContext } from "./value";
import type { LeagueSnapshot } from "@/types";

/**
 * Trades: buy low on league mates' players in a slump, sell high on yours running hot, and judge
 * any trade on rest-of-season points per game with health counted (src/lib/value.ts `ros`).
 *
 * The edge: managers judge players by what they've done lately; the value model judges them by
 * minutes, role and points per minute, with scoring luck leaning on the projection. A star shooting
 * badly for five games looks worse to his manager than he is; a bench guard on a hot streak looks
 * better. Trades that look fair on recent form but win on the model are the ones to offer.
 */

const SCORING = PRESETS[0].league.scoring;
const DAY = 864e5;
/** Nights of box scores to look back through for a player's last games. */
const LOOKBACK = 14;
/** Games that make "lately". */
const RECENT_GAMES = 5;
/** A swing this big (share of his expected points, and points a game) counts as a slump or a hot streak. */
const SWING_SHARE = 0.15;
const SWING_PTS = 4;
/** Don't trade for players who miss this much (share of games, long injuries aside). */
const MIN_DURABILITY = 0.8;
/** Or who are out longer than this. */
const MAX_OUT_DAYS = 14;
/** A trade has to gain at least this many points a game to suggest it. */
const MIN_GAIN = 1.5;

export interface TradePlayer {
  id: number;
  name: string;
  team: string;
  pos: string;
  pctOwned: number;
  /** Expected fantasy points in a game he plays. */
  perGame: number;
  /** Rest of season: expected points per team game left, with durability and injuries. */
  ros: number;
  /** His season average so far, and over his last few games (null without enough games). */
  season: number | null;
  recent: number | null;
  recentGames: number;
  /** "slump" or "hot" when his last games are well off what we expect from him. */
  form: "slump" | "hot" | null;
  /** What his manager probably thinks he's worth: mostly how he's played lately. */
  perceived: number;
  status: string;
  returnDate?: string;
  health: string;
  durability: number;
  /** Why not to trade for him (an injury, sits often), if any. */
  risk: string | null;
  /** His role leans on an injured teammate: who, and when that teammate is back. */
  temporary?: { because: string; until: string; minutesAfter: number };
}

const usDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const r1 = (n: number) => Math.round(n * 10) / 10;
const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

interface TradeContext {
  ctx: ValueContext;
  /** Fantasy points in each recent game played, newest first. */
  recentPts: Map<number, number[]>;
}

async function tradeContext(now = Date.now()): Promise<TradeContext> {
  const kv = kvStore();
  const nights = Array.from({ length: LOOKBACK }, (_, i) => easternDate(now - (i + 1) * DAY));
  const [ctx, fpts, mins] = await Promise.all([
    valueContext(now),
    Promise.all(nights.map((d) => kv.get<Record<string, number>>(`social:fpts:${d}`).catch(() => null))),
    Promise.all(nights.map((d) => kv.get<Record<string, number>>(`social:minutes:${d}`).catch(() => null))),
  ]);
  const recentPts = new Map<number, number[]>();
  nights.forEach((_, i) => {
    for (const [id, pts] of Object.entries(fpts[i] ?? {})) {
      if (!((mins[i]?.[id] ?? 0) > 0)) continue;
      const list = recentPts.get(Number(id)) ?? [];
      list.push(pts);
      recentPts.set(Number(id), list);
    }
  });
  return { ctx, recentPts };
}

function tradePlayer(p: Player, t: TradeContext): TradePlayer {
  const v = valuePlayer(p, t.ctx);
  const games = (t.recentPts.get(p.id) ?? []).slice(0, RECENT_GAMES);
  const recent = games.length >= 3 ? avg(games) : null;
  const season = p.cur?.gp ? fantasyPoints(p.cur, SCORING) : null;
  const gap = recent === null ? 0 : recent - v.perGame;
  const form = recent === null ? null : gap <= -Math.max(SWING_PTS, SWING_SHARE * v.perGame) ? "slump" : gap >= Math.max(SWING_PTS, SWING_SHARE * v.perGame) ? "hot" : null;
  // Managers go by the box scores (last few games, then the season) and by where he was ranked
  // before it: a hot week doesn't make a bench guard a star in anyone's eyes.
  const preseason = p.proj?.gp ? fantasyPoints(p.proj, SCORING) : p.last?.gp ? fantasyPoints(p.last, SCORING) : null;
  const box = recent !== null ? 0.6 * recent + 0.4 * (season ?? recent) : season ?? v.perGame;
  let perceived = preseason !== null ? 0.7 * box + 0.3 * preseason : box;
  if (v.status === "OUT") perceived *= v.returnDate ? 0.85 : 0.6;

  const daysOut = v.returnDate ? (Date.parse(v.returnDate) - t.ctx.now) / DAY : null;
  const risk =
    v.status === "OUT" && (daysOut === null || daysOut > MAX_OUT_DAYS)
      ? `is out${v.returnDate ? ` until about ${usDate(v.returnDate)}` : " with no return date"}`
      : v.health === "in-and-out" || v.durability < MIN_DURABILITY
        ? `sits often (plays about ${Math.round(v.durability * 100)}% of games)`
        : null;
  return {
    id: p.id, name: p.name, team: p.team, pos: p.pos.join("/"), pctOwned: Math.round(p.pctOwned ?? 0),
    perGame: v.perGame, ros: v.ros, season: season === null ? null : r1(season), recent: recent === null ? null : r1(recent), recentGames: games.length,
    form, perceived: r1(perceived), status: v.status, returnDate: v.returnDate, health: v.health, durability: v.durability, risk,
    ...(v.temporary ? { temporary: v.temporary } : {}),
  };
}

/**
 * What an open roster spot is worth: about the best player nobody rosters in a 10-team league (the
 * 131st best by rest-of-season value). A 2-for-1 frees a spot for one of these.
 */
function replacementLevel(t: TradeContext, rostered = 130): number {
  const vals = t.ctx.players
    .filter((p) => p.team !== "FA")
    .map((p) => valuePlayer(p, t.ctx).ros)
    .sort((a, b) => b - a);
  return vals[rostered] ?? 0;
}

/* ---------------- Rating one trade (the free checker) ---------------- */

export type TradeVerdict = "accept" | "close" | "decline";
interface TradeRating {
  give: TradePlayer[];
  get: TradePlayer[];
  /** Rest-of-season points a game it adds to your team (negative: it costs you). */
  gain: number;
  verdict: TradeVerdict;
  headline: string;
  reasons: string[];
}

const names = (ps: TradePlayer[]) => (ps.length > 1 ? `${ps.slice(0, -1).map((p) => p.name).join(", ")} and ${ps.at(-1)!.name}` : ps[0]?.name ?? "");
const sum = (ps: TradePlayer[], k: "ros" | "perceived") => ps.reduce((s, p) => s + p[k], 0);

/**
 * Your side's gain: what you get minus what you give, plus a free agent for every spot it opens.
 * Anyone worse than a free agent counts as one: you could swap him on waivers without a trade.
 */
const tradeGain = (give: TradePlayer[], get: TradePlayer[], repl: number, dropValue = repl) => {
  const eff = (ps: TradePlayer[]) => ps.reduce((s, p) => s + Math.max(p.ros, repl), 0);
  const spots = give.length - get.length;
  // Opening spots adds free agents; taking on more players means dropping your weakest.
  return eff(get) - eff(give) + spots * (spots > 0 ? repl : Math.max(dropValue, repl));
};

/**
 * How a manager weighs players: stars count for more than their points (two 30s don't buy a 60;
 * there's one lineup spot for him), so their side is judged on a curve.
 */
const worth = (x: number) => Math.max(0, x) ** 2 / 30;
const theirSide = (ps: TradePlayer[]) => ps.reduce((s, p) => s + worth(p.perceived), 0);

/** Why a player is or isn't worth it, in a line each. */
function notes(p: TradePlayer, side: "give" | "get"): string[] {
  const out: string[] = [];
  if (p.form === "slump" && p.recent !== null && !(side === "get" && p.risk))
    out.push(side === "get"
      ? `Buy low: ${p.name} has averaged ${p.recent} over his last ${p.recentGames} games, but his minutes and role say ${p.perGame}`
      : `${p.name} is in a slump (${p.recent} over his last ${p.recentGames}, ${p.perGame} expected): you'd be selling low`);
  if (p.form === "hot" && p.recent !== null)
    out.push(side === "give"
      ? `Sell high: ${p.name} has averaged ${p.recent} over his last ${p.recentGames} games; expect about ${p.perGame}`
      : `${p.name} is running hot (${p.recent} over his last ${p.recentGames}); expect about ${p.perGame} from here`);
  if (p.risk) out.push(`${p.name} ${p.risk}${side === "get" ? ": that's priced in, but it's a risk" : ""}`);
  if (p.temporary) out.push(`${p.name}'s minutes are up while ${p.temporary.because} is out (back about ${usDate(p.temporary.until)}); about ${p.temporary.minutesAfter} a game after`);
  return out;
}

function judgeTrade(give: TradePlayer[], get: TradePlayer[], repl: number): TradeRating {
  const gain = r1(tradeGain(give, get, repl));
  const verdict: TradeVerdict = gain >= MIN_GAIN ? "accept" : gain <= -MIN_GAIN ? "decline" : "close";
  const headline = {
    accept: `Take it: +${gain} points a game for you`,
    close: `About even: ${gain >= 0 ? "+" : ""}${gain} points a game`,
    decline: `Pass: it costs you ${-gain} points a game`,
  }[verdict];
  const reasons: string[] = [
    `Rest of season, counting games they'll miss: ${names(get)} ${r1(sum(get, "ros"))} a game vs ${names(give)} ${r1(sum(give, "ros"))}`,
  ];
  if (give.length !== get.length) {
    const opened = give.length - get.length;
    reasons.push(opened > 0
      ? `You open ${opened} roster ${opened === 1 ? "spot" : "spots"} for a free agent (about ${r1(repl)} a game each)`
      : `You need ${-opened} more roster ${opened === -1 ? "spot" : "spots"}: that drops a player worth about ${r1(repl)} a game`);
  }
  for (const p of get) reasons.push(...notes(p, "get"));
  for (const p of give) reasons.push(...notes(p, "give"));
  return { give, get, gain, verdict, headline, reasons: reasons.slice(0, 7) };
}

export async function rateTrade(giveIds: number[], getIds: number[], now = Date.now()): Promise<TradeRating | null> {
  if (!giveIds.length || !getIds.length || giveIds.some((id) => getIds.includes(id))) return null;
  const t = await tradeContext(now);
  const pick = (ids: number[]) => ids.map((id) => t.ctx.byId.get(id)).filter((p): p is Player => !!p).map((p) => tradePlayer(p, t));
  const give = pick(giveIds), get = pick(getIds);
  if (give.length !== giveIds.length || get.length !== getIds.length) return null;
  return judgeTrade(give, get, replacementLevel(t));
}

/* ---------------- Finding trades in a league (paid) ---------------- */

export interface TradeIdea {
  teamId: number;
  teamName: string;
  give: TradePlayer[];
  get: TradePlayer[];
  /** Your gain, rest-of-season points a game. */
  gain: number;
  /** How it looks to them, by recent box scores (positive: they'd likely say yes). */
  theirView: number;
  /** For a 1-for-2: who you'd drop to make room. */
  drop?: TradePlayer;
  why: string[];
}

export interface TradeFinder {
  /** League mates' players in a slump: ask about them now. */
  buyLow: (TradePlayer & { teamId: number; teamName: string })[];
  /** Your roster, for picking the trade block. */
  roster: TradePlayer[];
  /** Yours worth more to other managers than to you (a hot streak, a role that ends, sits often): shop them now. */
  sellHigh: (TradePlayer & { why: string })[];
  ideas: TradeIdea[];
  replacement: number;
}

/**
 * Sell-high: worth this much more to other managers than to you. They see points when he plays;
 * rest-of-season value counts missed games, so compare against a typical player's games played.
 */
const SELL_GAP = 5;
const TYPICAL_PLAYED = 0.9;
const overrated = (p: TradePlayer) => p.perceived * TYPICAL_PLAYED - p.ros;

/** Why a player looks better to other managers than he'll be for you, or null if he doesn't. */
function oversold(p: TradePlayer): string | null {
  if (overrated(p) < SELL_GAP) return null;
  const buts = [
    p.risk,
    p.temporary && `loses minutes when ${p.temporary.because} is back (about ${usDate(p.temporary.until)})`,
  ].filter(Boolean);
  const looks = p.form === "hot" && p.recent !== null ? `is averaging ${p.recent} lately` : `looks like a ${Math.round(p.perceived)}-point player to other managers`;
  return `${p.name} ${looks}${buts.length ? `, but he ${buts.join(" and ")}` : `; expect about ${p.perGame}`}.`;
}

/** Why the trade works: who you're buying low, who looks better to them than he is, and the depth they get. */
function pitch(give: TradePlayer[], get: TradePlayer[]): string[] {
  const out: string[] = [];
  for (const p of get) {
    if (p.form === "slump") out.push(`${p.name} is slumping: ${p.recent} a game over his last ${p.recentGames}, but his minutes and role say ${p.perGame}.`);
  }
  for (const p of give) {
    const o = oversold(p);
    if (o) out.push(o);
  }
  if (give.length > get.length) out.push(`They get ${give.length} players for 1; you get the best player in the deal.`);
  if (!out.length) out.push("Looks fair on the box scores; wins on minutes and role.");
  return out;
}

/**
 * block: the players you're open to trading (your trade block). Offers only send these; empty
 * means anyone on your roster.
 */
export async function findTrades(snapshot: LeagueSnapshot, block: number[] = [], now = Date.now()): Promise<TradeFinder> {
  const t = await tradeContext(now);
  const repl = replacementLevel(t, snapshot.teams.length * 13);
  const toTP = (id: number) => {
    const p = t.ctx.byId.get(id);
    return p ? tradePlayer(p, t) : null;
  };
  const rosterOf = (teamId: number) =>
    (snapshot.teams.find((x) => x.id === teamId)?.roster ?? []).map((r) => toTP(r.player.id)).filter((p): p is TradePlayer => !!p);
  const mine = rosterOf(snapshot.myTeamId);
  const onBlock = mine.filter((p) => block.includes(p.id));
  const offer = onBlock.length ? onBlock : mine;
  const others = snapshot.teams.filter((x) => x.id !== snapshot.myTeamId).map((x) => ({ id: x.id, name: x.name, roster: rosterOf(x.id) }));

  const buyLow = others
    .flatMap((o) => o.roster.filter((p) => p.form === "slump" && !p.risk).map((p) => ({ ...p, teamId: o.id, teamName: o.name })))
    .sort((a, b) => (b.perGame - (b.recent ?? 0)) - (a.perGame - (a.recent ?? 0)))
    .slice(0, 10);
  const sellHigh = mine
    .map((p) => ({ ...p, why: oversold(p) }))
    .filter((p): p is TradePlayer & { why: string } => !!p.why)
    .sort((a, b) => overrated(b) - overrated(a))
    .slice(0, 5);

  const ideas: TradeIdea[] = [];
  for (const o of others) {
    // Their weakest player is who they'd cut to make room in a 2-for-1.
    const theirWorst = Math.min(...o.roster.filter((p) => p.status !== "OUT").map((p) => p.perceived), Infinity);
    const cut = Number.isFinite(theirWorst) ? theirWorst : repl;
    const targets = o.roster.filter((p) => !p.risk);
    const offers: TradeIdea[] = [];
    const consider = (give: TradePlayer[], get: TradePlayer[]) => {
      // Taking on more players than you send: drop your weakest healthy player not in the deal
      // (an injured player is low only until he's back).
      const drop = get.length > give.length ? mine.filter((p) => !give.includes(p) && p.status !== "OUT").sort((a, b) => a.ros - b.ros)[0] : undefined;
      if (get.length > give.length && !drop) return;
      const gain = tradeGain(give, get, repl, drop?.ros);
      if (gain < MIN_GAIN) return;
      const spots = give.length - get.length;
      // They cut their weakest to fit extra players, or pick up a free agent with a spot you open for them.
      const theirView = theirSide(give) - theirSide(get) - spots * worth(spots > 0 ? cut : repl);
      if (theirView < 0) return;
      const why = pitch(give, get);
      if (drop) why.push(`You turn 1 player into 2 rotation players; drop ${drop.name} (${drop.ros} a game) to make room.`);
      offers.push({ teamId: o.id, teamName: o.name, give, get, gain: r1(gain), theirView: r1(theirView), why, ...(drop ? { drop } : {}) });
    };
    for (const g of targets) {
      for (let i = 0; i < offer.length; i++) {
        consider([offer[i]], [g]);
        for (let j = i + 1; j < offer.length; j++) consider([offer[i], offer[j]], [g]);
      }
    }
    // 1-for-2: one of yours for two of theirs.
    for (let a = 0; a < targets.length; a++)
      for (let b = a + 1; b < targets.length; b++)
        for (const m of offer) consider([m], [targets[a], targets[b]]);
    // Their two best offers that don't share a player.
    offers.sort((a, b) => b.gain - a.gain);
    const used = new Set<number>();
    let n = 0;
    for (const x of offers) {
      const ids = [...x.give, ...x.get].map((p) => p.id);
      if (ids.some((id) => used.has(id))) continue;
      ids.forEach((id) => used.add(id));
      ideas.push(x);
      if (++n === 2) break;
    }
  }
  // Best first, with each of your players in at most 3 ideas so one sell-high doesn't fill the list.
  ideas.sort((a, b) => b.gain - a.gain);
  const uses = new Map<number, number>();
  const picked = ideas.filter((x) => {
    if (x.give.some((p) => (uses.get(p.id) ?? 0) >= 3)) return false;
    x.give.forEach((p) => uses.set(p.id, (uses.get(p.id) ?? 0) + 1));
    return true;
  });
  return { buyLow, sellHigh, ideas: picked.slice(0, 10), replacement: r1(repl), roster: [...mine].sort((a, b) => b.ros - a.ros) };
}
