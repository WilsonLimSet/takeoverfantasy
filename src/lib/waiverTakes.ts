import { boxLines, easternDate, risersFallers, minutesWatch, streamWindow, yesterday } from "./social";
import { kvStore } from "./inseason/storage";
import { valueContext, valuePlayer, type PlayerValue } from "./value";
import { writeCopy, writeSatire } from "./socialEditor";

/**
 * "Waiver takes": a call on each player people are talking about this morning (last night's big
 * games, the most added, the minutes risers), made by the value model, not by vibes. Hold means
 * he's worth a roster spot for the season, stream means only for now (a teammate is out or the
 * schedule is good), stash means hold him on IR, pass means the hype isn't backed by a role.
 * The day's takes are saved, so every slide and caption shows the same calls.
 */

export type TakeVerdict = "hold" | "stream" | "stash" | "pass";

export interface WaiverTake {
  id: number;
  name: string;
  team: string;
  pos: string;
  pctOwned: number;
  verdict: TakeVerdict;
  /** A short punchline for the slide. */
  quip: string;
  /** Why, in a sentence or two. */
  reason: string;
  /** Why he's in the conversation: "38 fpts last night", "+12% rostered today", "minutes up". */
  hook: string;
  perGame: number;
  minutes: number;
  lastMin: number | null;
  /** His game last night, when that's why he's here. */
  night?: { fpts: number; min: number; line: string };
  /** Claude's words for the single post (src/lib/socialEditor.ts); templates when missing. */
  post?: string;
  caption?: string;
}

/**
 * A widely rostered player who stank last night (a full game's minutes, a fraction of his usual
 * points): material for a satire post. The fantasy call still comes from the model.
 */
export interface Flop {
  id: number; name: string; team: string; pos: string; pctOwned: number;
  fpts: number; min: number; line: string; fg: string; tov: number;
  /** What he usually scores. */
  perGame: number;
  verdict: TakeVerdict;
  /** Claude's satire (src/lib/socialEditor.ts); no post without it. */
  headline?: string; post?: string; caption?: string;
}

/** The day's takes plus the editor's picks: which take leads the photo post and which the headline. */
interface TakesDay { takes: WaiverTake[]; photoId?: number; headlineId?: number; carouselCaption?: string; flop?: Flop }

/** Players rostered in about this many leagues of ten teams count as roster-worthy (ESPN rosters 13). */
const ROSTERED = 120;
const MAX_OWNED = 60;

const QUIPS: Record<TakeVerdict, string[]> = {
  hold: ["This one's real.", "Not a one-night thing.", "Roster him and leave him."],
  stream: ["Rent, don't buy.", "Good for now, not forever.", "Ride it, then let go."],
  stash: ["Worth the IR spot.", "Patience pays here."],
  pass: ["One big night isn't a role.", "Don't chase it.", "The box score lied."],
};

const fmtDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function decide(v: PlayerValue, repl: { ros: number; perGame: number }, streamable: number): TakeVerdict {
  if (v.status === "OUT") return v.perGame >= repl.perGame ? "stash" : "pass";
  if (v.ros >= repl.ros) return "hold";
  if (v.temporary && v.perGame >= repl.perGame * 0.9) return "stream";
  if (v.window >= streamable) return "stream";
  return "pass";
}

function explain(t: { name: string; lastMin: number | null; fpts?: number; min?: number }, v: PlayerValue, verdict: TakeVerdict, window: string): string {
  const first = t.name.split(" ").slice(-1)[0];
  const mins = `${Math.round(v.minutes)} minutes a night${t.lastMin ? ` (${Math.round(t.lastMin)} last season)` : ""}`;
  const steady = v.steady >= 0.5 ? ", and most of his points come from boards, assists and stocks, so they hold up" : "";
  if (verdict === "stash") return `Out until about ${v.returnDate ? fmtDate(v.returnDate) : "later this month"}, then worth ${Math.round(v.perGame)} fantasy points a game. Hold him on IR.`;
  if (verdict === "hold") {
    if (v.health === "in-and-out") return `${mins}, worth ${Math.round(v.perGame)} a game. He sits often, but the role is big enough to keep.`;
    return `${mins}, worth about ${Math.round(v.perGame)} fantasy points a game${steady}.`;
  }
  if (verdict === "stream") {
    if (v.temporary) return `His minutes are up while ${v.temporary.because} is out (back around ${fmtDate(v.temporary.until)}). About ${Math.round(v.temporary.minutesAfter)} minutes once he's back, so drop ${first} then.`;
    return `${v.games} games in the ${window.toLowerCase()} at about ${Math.round(v.perGame)} a game. Use the schedule, then move on.`;
  }
  if (t.fpts && t.min) return `${t.fpts} last night on ${Math.round(t.min)} minutes, but he projects ${Math.round(v.perGame)} a game on ${Math.round(v.minutes)} minutes. That was his ceiling, not his role.`;
  return `Everyone's adding him, but ${Math.round(v.minutes)} minutes and ${Math.round(v.perGame)} fantasy points a game doesn't beat what's already on your bench.`;
}

/**
 * Today's takes, with Claude's words on them, saved once per day so every slide and caption agrees
 * (and a rerun doesn't change the calls).
 */
export async function takesDay(date = easternDate(Date.now()), limit = 5): Promise<TakesDay> {
  const kv = kvStore();
  const key = `social:takesDay:${date}`;
  const saved = await kv.get<TakesDay>(key).catch(() => null);
  if (saved?.takes.length) return saved;
  const { takes, flop } = await buildTakes(date, limit);
  const [copy, satire] = await Promise.all([writeCopy(takes), flop ? writeSatire(flop) : null]);
  const day: TakesDay = {
    takes: takes.map((t) => {
      const c = copy?.takes[t.id];
      return c ? { ...t, quip: c.quip || t.quip, reason: c.reason || t.reason, ...(c.post ? { post: c.post } : {}), ...(c.caption ? { caption: c.caption } : {}) } : t;
    }),
    photoId: copy?.photoId, headlineId: copy?.headlineId, carouselCaption: copy?.carouselCaption,
    ...(flop && satire ? { flop: { ...flop, ...satire } } : {}),
  };
  // Only production pins the day's calls (a preview or local run shouldn't).
  if (takes.length && process.env.VERCEL_ENV === "production") await kv.set(key, day).catch(() => {});
  return day;
}

export const waiverTakes = async (date?: string, limit?: number) => (await takesDay(date, limit)).takes;

/**
 * A satire-worthy night: 60%+ rostered, 24+ minutes (so not an injury exit), and either under 55%
 * of his usual points or brick-laying (30% or worse on 15+ shots) on a below-par night.
 */
const FLOP_MIN_OWNED = 60;

async function buildTakes(date: string, limit: number): Promise<{ takes: WaiverTake[]; flop?: Flop }> {
  const night = yesterday(new Date(`${date}T16:00:00Z`).getTime());
  const [ctx, box, movers, minutes] = await Promise.all([
    valueContext(),
    boxLines(night).catch(() => ({ lines: [] as Awaited<ReturnType<typeof boxLines>>["lines"] })),
    risersFallers(10).catch(() => ({ risers: [] as Awaited<ReturnType<typeof risersFallers>>["risers"] })),
    minutesWatch(8).catch(() => ({ up: [] as Awaited<ReturnType<typeof minutesWatch>>["up"] })),
  ]);
  const w = streamWindow();
  const range = { from: w.from, to: w.end };

  // Replacement level: the 120th best player is about the last one rostered in a 10-team league.
  const values = ctx.players.filter((p) => p.team !== "FA").map((p) => valuePlayer(p, ctx, range));
  const nth = (xs: number[]) => xs.sort((a, b) => b - a)[ROSTERED - 1] ?? 0;
  const repl = { ros: nth(values.map((v) => v.ros)), perGame: nth(values.map((v) => v.perGame)) };
  // A schedule stream has to beat a typical bench player's week by a clear margin.
  const streamable = nth(values.map((v) => v.window)) * 1.15;

  // Who people are talking about, loudest first.
  // Each player's loudest reason is his hook; showing up in more than one list adds to his score.
  const heat = new Map<number, { score: number; best: number; hook: string; fpts?: number; min?: number; line?: string }>();
  const bump = (id: number, score: number, hook: string, extra?: { fpts: number; min: number; line: string }) => {
    const cur = heat.get(id);
    if (!cur) return void heat.set(id, { score, best: score, hook, ...extra });
    if (score > cur.best) Object.assign(cur, { best: score, hook });
    Object.assign(cur, { score: cur.score + score * 0.3 }, extra);
  };
  for (const l of box.lines.filter((l) => l.pctOwned < MAX_OWNED && l.fpts >= 30).sort((a, b) => b.fpts - a.fpts).slice(0, 8)) bump(l.id, l.fpts, `${l.fpts} fpts last night`, { fpts: l.fpts, min: l.min, line: l.line });
  for (const m of movers.risers.filter((m) => m.pctOwned < MAX_OWNED).slice(0, 8)) bump(m.id, 20 + m.pctChange * 2, `+${Math.round(m.pctChange)}% rostered today`);
  for (const m of minutes.up.slice(0, 6)) bump(m.id, 18 + (m.min - m.lastMin), `${Math.round(m.min)} min a night (was ${Math.round(m.lastMin)})`);

  const rated = [...heat.entries()]
    .map(([id, h]) => {
      const p = ctx.byId.get(id);
      if (!p || p.team === "FA") return null;
      const v = valuePlayer(p, ctx, range);
      const verdict = decide(v, repl, streamable);
      const lastMin = p.last?.gp ? Math.round(p.last.min * 10) / 10 : null;
      const take: WaiverTake = {
        id, name: p.name, team: p.team, pos: p.pos.join("/"), pctOwned: Math.round(p.pctOwned ?? 0), verdict,
        quip: "", reason: explain({ name: p.name, lastMin, fpts: h.fpts, min: h.min }, v, verdict, w.label),
        hook: h.hook, perGame: Math.round(v.perGame * 10) / 10, minutes: Math.round(v.minutes * 10) / 10, lastMin,
        ...(h.fpts && h.min && h.line ? { night: { fpts: h.fpts, min: Math.round(h.min), line: h.line } } : {}),
      };
      return { take, score: h.score };
    })
    .filter((x): x is { take: WaiverTake; score: number } => !!x)
    .sort((a, b) => b.score - a.score);

  // A mix of calls: no more than two of the same verdict.
  const out: WaiverTake[] = [];
  const count: Partial<Record<TakeVerdict, number>> = {};
  for (const { take } of rated) {
    if ((count[take.verdict] ?? 0) >= 2) continue;
    const k = count[take.verdict] ?? 0;
    // Quips rotate by day so two takes, or two days in a row, don't repeat the same line.
    const quips = QUIPS[take.verdict];
    out.push({ ...take, quip: quips[(k + Number(date.replaceAll("-", ""))) % quips.length] });
    count[take.verdict] = k + 1;
    if (out.length === limit) break;
  }
  return { takes: out, flop: findFlop(box.lines, ctx, repl, streamable, range) };
}

function findFlop(lines: Awaited<ReturnType<typeof boxLines>>["lines"], ctx: Awaited<ReturnType<typeof valueContext>>, repl: { ros: number; perGame: number }, streamable: number, range: { from: string; to: string }): Flop | undefined {
  const flops = lines
    .filter((l) => l.pctOwned >= FLOP_MIN_OWNED && l.min >= 24)
    .map((l) => {
      const p = ctx.byId.get(l.id);
      if (!p) return null;
      const v = valuePlayer(p, ctx, range);
      if (v.status === "OUT" || v.perGame < 20) return null;
      const [made, shots] = l.fg.split("-").map(Number);
      const bricks = shots >= 15 && made / shots <= 0.3;
      const ratio = l.fpts / v.perGame;
      if (!(ratio <= 0.55 || (bricks && ratio <= 0.85))) return null;
      // Worst first: points against his usual, with ugly shooting counting extra.
      return { l, p, v, ratio: ratio - (bricks ? 0.25 : 0) };
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => a.ratio - b.ratio);
  const f = flops[0];
  if (!f) return undefined;
  return {
    id: f.p.id, name: f.p.name, team: f.p.team, pos: f.p.pos.join("/"), pctOwned: f.l.pctOwned, fpts: f.l.fpts, min: Math.round(f.l.min),
    line: f.l.line, fg: f.l.fg, tov: f.l.tov, perGame: Math.round(f.v.perGame), verdict: decide(f.v, repl, streamable),
  };
}

/** The take as one post, for the tweet-style card and its caption. */
export function takeLine(t: WaiverTake): string {
  if (t.post) return t.post;
  const first = t.name.split(" ").slice(-1)[0];
  if (t.verdict === "pass" && t.night) return `${t.name} dropped ${t.night.fpts} fantasy points last night. We're still passing: ${first} projects ${Math.round(t.perGame)} a game on ${Math.round(t.minutes)} minutes.`;
  if (t.verdict === "hold") return `${t.name} is on waivers in ${100 - t.pctOwned}% of leagues and he's playing ${Math.round(t.minutes)} minutes a night. This one's real. Go get him.`;
  return t.reason;
}

export function takesCaption(takes: WaiverTake[]): string {
  const label: Record<TakeVerdict, string> = { hold: "HOLD", stream: "STREAM", stash: "STASH", pass: "PASS" };
  return [
    `${takes.length} players everyone's talking about. ${takes.length} calls.`,
    "",
    ...takes.map((t) => `${t.name}: ${label[t.verdict]}. ${t.quip}`),
    "",
    "Based on minutes, not vibes. Disagree? Tell us below.",
  ].join("\n");
}
