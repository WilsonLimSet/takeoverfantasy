import { generateText, Output } from "ai";
import { z } from "zod";
import { withModel } from "./ai";
import { backupPlan, type BackupPick } from "./backupPlan";
import { getPlayers, SEASON } from "./data";
import { fetchPlayerNews } from "./playerNews";
import { EMAIL_ON, espnAddUrl, sendEmail } from "./inseason/email";
import { RECIPIENT_MIN, shareMinutes, type RotationPlayer } from "./inseason/opportunity";
import { listProfiles, profileContext, withAccess, type InseasonProfile } from "./inseason/profile";
import { injuryReport, type InjuryReportEntry } from "./inseason/stash";
import { kvStore } from "./inseason/storage";
import { sendTelegramTo, TELEGRAM_ON } from "./inseason/telegramUser";
import { BOX_TEAM, cardUrl, CTA, easternDate, NBA, SITE, TAGS } from "./social";
import { sendToPostroom } from "./postroom";
import type { LeagueSnapshot } from "@/types";
import type { Player } from "./types";
import { valueContext, type ValueContext } from "./value";
import { perGameCore } from "./valueCore";

/**
 * Breaking injury alerts, checked every 10 minutes: when a widely rostered player is newly ruled
 * out for more than a game or two, tell people right away with who gets his minutes, so they can
 * grab the pickup before their league mates see the news. Users with a connected league also learn
 * whether the pickup is still free there (with the ESPN add link) and whether the injured player is
 * theirs. Two sources: ESPN's injury report, and ESPN's player news, which Claude reads as it lands
 * (often before the report's status changes). Claude also picks the best pickup from the teammates
 * our minutes split flags, with a one-line reason; only new news is read, so it costs cents a day.
 */

/** Rostered in this share of ESPN leagues: injuries to deeper players don't move anyone. */
const MIN_OWNED = 40;
/** Absences shorter than this (a game or two) aren't worth a pickup. */
const MIN_DAYS_OUT = 3;
/** Pickups rostered more than this are already gone in most leagues. */
const PICKUP_MAX_OWNED = 60;
/**
 * Public posts (Instagram, Threads, X) only for players this widely rostered and out a few weeks or
 * more (Wilson: a week-long absence isn't big news), at most this many a day.
 */
const POST_MIN_OWNED = 50;
const POST_MIN_DAYS = 14;
const POSTS_PER_DAY = 2;
/**
 * Ruled out tonight: stars only, posted before tip-off (with time to swap a lineup) or not at all,
 * and never rest or load management.
 */
const TONIGHT_MIN_OWNED = 70;
const TONIGHT_LEAD_MS = 20 * 60 * 1000;
const TONIGHT_PER_DAY = 3;
const NOT_INJURY = /\brest\b|load management|injury management|personal|not injury/i;
/** Email only for the biggest names, to stay inside the email provider's daily limit. */
const EMAIL_MIN_OWNED = 70;
const STATUS_KEY = "breaking:status";
const OWNER_CHATS = "social:ownerChats";
const DAY = 864e5;

export interface Pickup { id: number; name: string; team: string; pctOwned: number; minutes: number; fppg: number; reason?: string }
export interface BreakingEvent {
  player: { id: number; name: string; team: string; pctOwned: number };
  injury?: string;
  note: string;
  returnDate?: string;
  pickups: Pickup[];
  /** Where we heard it first. */
  source: "injury report" | "news";
  /** Out for weeks (a timeline of POST_MIN_DAYS+, or news of surgery or a long injury with no date yet). */
  longTerm?: boolean;
  /** Ruled out of tonight's game only: the opponent and tip-off (ms). */
  tonight?: { opp: string; tip: number };
}

const isOut = (e?: InjuryReportEntry) => !!e && /out|injur|suspen/i.test(e.status);

/**
 * The best pickups while he's out: teammates who gain real minutes (the shared minutes split),
 * ranked by what they'll score in that time (their own value plus the extra minutes), so a
 * rotation player stepping up beats a deep bench guy who only gains a few garbage minutes.
 */
function pickupsFor(out: Player, players: Player[], report: Map<number, InjuryReportEntry>): Pickup[] {
  const rot = (p: Player): RotationPlayer => {
    const core = perGameCore(p);
    const gp = p.cur?.gp ?? 0;
    return { id: p.id, positions: p.pos, minutes: core.minutes, fppg: core.perGame, minutesWeight: gp / (gp + 3), gamesPlayed: gp };
  };
  const healthy = players.filter((p) => p.team === out.team && p.id !== out.id && !isOut(report.get(p.id))).map(rot).filter((p) => p.minutes >= RECIPIENT_MIN);
  const byId = new Map(players.map((p) => [p.id, p]));
  const base = new Map(healthy.map((p) => [p.id, p.fppg]));
  return shareMinutes(rot(out), healthy, 0)
    .filter((s) => s.minutes >= 2)
    .filter((s) => byId.has(s.id))
    .map((s) => ({ id: s.id, name: byId.get(s.id)!.name, team: out.team, pctOwned: Math.round(byId.get(s.id)!.pctOwned ?? 0), minutes: Math.round(s.minutes), fppg: Math.round((base.get(s.id) ?? 0) + s.fppg) }))
    .sort((a, b) => b.fppg - a.fppg)
    .filter((p) => p.pctOwned < PICKUP_MAX_OWNED)
    .slice(0, 5);
}

const NEWS_SEEN_KEY = "breaking:newsSeen";
/** Players whose news Claude reads in one check (a busy night stays cheap). */
const NEWS_PER_CHECK = 15;
const PLAYERS_FEED = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/${SEASON}/players?view=players_wl`;
/** One alert per player per injury: the two sources and timeline tweaks don't repeat it. */
const sentKey = (id: number) => `breaking:sent:${id}`;
/** After this long a player can alert again (a new injury), so a stale key never blocks him for good. */
const SENT_TTL_MS = 14 * DAY;
/** News older than this when we first see it is old news, not breaking. */
const NEWS_MAX_AGE_MS = 3 * 60 * 60 * 1000;

/** The opening of a news item for the alert: whole sentences, under about 240 characters. */
function firstSentences(text: string): string {
  let out = "";
  for (const s of text.split("\n")[0].split(/(?<=[.!?])\s+/)) {
    if ((out + " " + s).trim().length > 240) break;
    out = (out + " " + s).trim();
  }
  return out || text.slice(0, 240);
}

/** When each player last had news, from one light ESPN request covering every player. */
async function lastNewsTimes(): Promise<Map<number, number>> {
  const r = await fetch(PLAYERS_FEED, { cache: "no-store", headers: { Accept: "application/json", "x-fantasy-filter": JSON.stringify({ filterActive: { value: true } }) } });
  if (!r.ok) throw new Error(`ESPN players: ${r.status}`);
  const out = new Map<number, number>();
  for (const p of (await r.json()) as { id: number; lastNewsDate?: number }[]) if (p.lastNewsDate) out.set(p.id, p.lastNewsDate);
  return out;
}

const verdict = z.object({
  playerId: z.number(),
  out: z.boolean().describe("True only if the news says he will miss an extended stretch: more than two games or several days (out X weeks, surgery, multi-week injury, long suspension). False for being ruled out of a single game or two, questionable, probable, day-to-day, rest, returning, or anything else."),
  days: z.number().int().min(0).max(365).nullable().describe("Expected days out from today if the news gives a timeline (2 weeks = 14), null if none."),
  injury: z.string().nullable().describe("Body part and type, e.g. 'left hamstring strain', or null."),
  longTerm: z.boolean().describe("True if he'll likely miss at least two weeks: a timeline of two weeks or more, surgery, a fracture or tear, or 'out indefinitely' with a serious injury."),
});

/** Claude reads the newest items for players with fresh news and says who's out, and for how long. */
async function readNews(items: { playerId: number; name: string; team: string; text: string }[]) {
  if (!items.length) return [];
  const { output } = await withModel((model) => generateText({
    model,
    system: "You read NBA player news for a fantasy basketball alert service that tells managers to pick up a replacement. For each player, decide from the news text only whether he will now miss an extended stretch (more than two games), and for about how long. Be conservative: single-game absences, uncertain timelines and game-time decisions are not out.",
    prompt: items.map((x) => `playerId ${x.playerId} | ${x.name} (${x.team})\n${x.text}`).join("\n\n"),
    output: Output.object({ schema: z.object({ verdicts: z.array(verdict) }) }),
  }));
  return output.verdicts;
}

/**
 * Claude picks the best pickup from the teammates our minutes split already flagged (never anyone
 * else), with a one-line reason: it catches what minutes alone miss, like a backup point guard
 * taking over the ball-handling.
 */
async function choosePickup(ev: BreakingEvent): Promise<BreakingEvent> {
  if (ev.pickups.length < 2) return ev;
  const res = await withModel((model) => generateText({
    model,
    system: "You are a sharp NBA fantasy basketball analyst (points leagues). Pick the best waiver pickup while a player is out, only from the candidates given, using their role, minutes, recent value and the news. Answer with the candidate's id and one short reason (under 15 words) a fantasy manager would find useful.",
    prompt: `Out: ${ev.player.name} (${ev.player.team})${ev.returnDate ? `, back around ${ev.returnDate}` : ""}.\nNews: ${ev.note}\n\nCandidates (extra minutes from our model, fantasy points a game while he's out, % rostered):\n${ev.pickups.map((p) => `id ${p.id} | ${p.name} | +${p.minutes} min | ~${p.fppg} pts | ${p.pctOwned}%`).join("\n")}`,
    output: Output.object({ schema: z.object({ id: z.number(), reason: z.string() }) }),
  })).catch((e) => { console.error("[breaking] pickup choice", e); return null; });
  const chosen = res && ev.pickups.find((p) => p.id === res.output.id);
  if (!chosen) return { ...ev, pickups: ev.pickups.slice(0, 3) };
  return { ...ev, pickups: [{ ...chosen, reason: res!.output.reason.slice(0, 120) }, ...ev.pickups.filter((p) => p !== chosen)].slice(0, 3) };
}

/** Claim the one alert for this player; an old claim (past SENT_TTL_MS) expires first. */
async function claimAlert(id: number, now: number): Promise<boolean> {
  const kv = kvStore();
  const at = await kv.get<number>(sentKey(id));
  if (at && now - at < SENT_TTL_MS) return false;
  if (at) await kv.delete(sentKey(id));
  return kv.claim(sentKey(id), now);
}

/**
 * Players newly ruled out since the last check (the first check only records the baseline). The
 * check's state is saved last, and news only counts as seen once Claude has read it, so a failure
 * mid-run means a retry next run rather than a lost alert. dry: change nothing.
 */
export async function detectBreaking(now = Date.now(), dry = false): Promise<{ events: BreakingEvent[]; tonight: BreakingEvent[]; seeded: boolean }> {
  const kv = kvStore();
  const [report, { players }, prev, newsSeen, newsTimes] = await Promise.all([
    injuryReport(true), getPlayers(), kv.get<Record<string, string>>(STATUS_KEY), kv.get<Record<string, number>>(NEWS_SEEN_KEY),
    lastNewsTimes().catch((e) => { console.error("[breaking] news times", e); return null; }),
  ]);
  const status: Record<string, string> = {};
  for (const [id, e] of report) status[id] = isOut(e) ? `out:${e.returnDate ?? ""}` : "dtd";
  const relevant = (p: Player) => p.team !== "FA" && (p.pctOwned ?? 0) >= MIN_OWNED;
  // News for players we don't watch counts as seen right away; watched players' only once read.
  const seen: Record<string, number> = { ...(newsSeen ?? {}) };
  const relevantIds = new Set(players.filter(relevant).map((p) => p.id));
  for (const [id, t] of newsTimes ?? []) if (!newsSeen || !relevantIds.has(id)) seen[id] = Math.max(seen[id] ?? 0, t);
  const save = async () => { if (!dry) await Promise.all([kv.set(STATUS_KEY, status), kv.set(NEWS_SEEN_KEY, seen)]); };
  if (!prev) { await save(); return { events: [], tonight: [], seeded: true }; }

  const today = easternDate(now);
  const found: { p: Player; injury?: string; note: string; returnDate?: string; source: BreakingEvent["source"]; longTerm?: boolean }[] = [];
  const longFrom = (d?: string) => !!d && Date.parse(d) - Date.parse(today) >= POST_MIN_DAYS * DAY;
  for (const p of players) {
    const e = report.get(p.id);
    if (!relevant(p) || !isOut(e) || prev[p.id]?.startsWith("out:")) continue;
    // The report alone needs a timeline: "out" with no date flips on and off with game-time
    // decisions. Undated long absences reach us through the news instead.
    if (!e!.returnDate) continue;
    found.push({ p, injury: e!.injury, note: e!.note, returnDate: e!.returnDate, source: "injury report", longTerm: longFrom(e!.returnDate) });
  }
  // Fresh news for watched players not already out on the report: Claude reads it.
  if (newsSeen && newsTimes) {
    const fresh = players
      .filter((p) => relevant(p) && !isOut(report.get(p.id)) && !found.some((f) => f.p.id === p.id) && (newsTimes.get(p.id) ?? 0) > (newsSeen[p.id] ?? 0))
      .slice(0, NEWS_PER_CHECK);
    if (fresh.length) {
      const texts = await Promise.all(fresh.map(async (p) => {
        const since = Math.max(newsSeen[p.id] ?? 0, now - NEWS_MAX_AGE_MS) - 60_000;
        const items = (await fetchPlayerNews(p.id, 2, true)).filter((n) => Date.parse(n.published) > since);
        return { p, text: items.map((n) => `${n.headline.replace(/[.!]+$/, "")}. ${n.analysis}`).join("\n") };
      }));
      const toRead = texts.filter((t) => t.text);
      try {
        const verdicts = await readNews(toRead.map((t) => ({ playerId: t.p.id, name: t.p.name, team: t.p.team, text: t.text })));
        // Read (or nothing new to read): now it counts as seen. Players past the per-check cap wait for the next run.
        for (const t of texts) seen[t.p.id] = newsTimes.get(t.p.id) ?? seen[t.p.id];
        for (const v of verdicts.filter((v) => v.out)) {
          const t = toRead.find((x) => x.p.id === v.playerId);
          const returnDate = v.days != null ? easternDate(now + v.days * DAY) : undefined;
          if (t) found.push({ p: t.p, injury: v.injury ?? undefined, note: firstSentences(t.text), returnDate, source: "news", longTerm: v.longTerm || longFrom(returnDate) });
        }
      } catch (e) {
        console.error("[breaking] news read failed; retrying next run", e);
      }
    }
  }

  const events: BreakingEvent[] = [];
  for (const f of found) {
    // A known short absence isn't a pickup moment.
    if (f.returnDate && Date.parse(f.returnDate) - Date.parse(today) < MIN_DAYS_OUT * DAY) continue;
    try {
      if (dry ? await kv.get(sentKey(f.p.id)) : !(await claimAlert(f.p.id, now))) continue;
      events.push(await choosePickup({
        player: { id: f.p.id, name: f.p.name, team: f.p.team, pctOwned: Math.round(f.p.pctOwned ?? 0) },
        injury: f.injury, note: f.note, returnDate: f.returnDate, pickups: pickupsFor(f.p, players, report), source: f.source, longTerm: f.longTerm,
      }));
    } catch (e) {
      // Give the claim back so the next run can try this player again.
      console.error("[breaking] event failed", f.p.name, e);
      if (!dry) await kv.delete(sentKey(f.p.id)).catch(() => {});
    }
  }
  const tonight = await outTonight({ players, report, prev, now, skip: new Set(found.filter((f) => f.longTerm).map((f) => f.p.id)), dry }).catch((e) => { console.error("[breaking] tonight", e); return []; });
  await save();
  return { events, tonight, seeded: false };
}

/** Today's games by team (our codes): opponent, tip-off, and whether it has started. */
async function tipoffs(date: string): Promise<Map<string, { opp: string; tip: number; started: boolean }>> {
  const r = await fetch(`${NBA}/scoreboard?dates=${date.replace(/-/g, "")}`, { cache: "no-store", headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`ESPN scoreboard: ${r.status}`);
  const out = new Map<string, { opp: string; tip: number; started: boolean }>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const e of ((await r.json())?.events ?? []) as any[]) {
    const comp = e?.competitions?.[0];
    const teams = ((comp?.competitors ?? []) as { team?: { abbreviation?: string } }[]).map((c) => BOX_TEAM[c.team?.abbreviation ?? ""] ?? String(c.team?.abbreviation ?? ""));
    const tip = Date.parse(comp?.date ?? e?.date);
    const started = e?.status?.type?.state !== "pre";
    if (teams.length === 2 && Number.isFinite(tip)) teams.forEach((t, i) => out.set(t, { opp: teams[1 - i], tip, started }));
  }
  return out;
}

/**
 * Stars newly ruled out of tonight's game (not rest or load management), while there's still time
 * before tip-off to start someone else; each with the teammate who gets his minutes. Anyone out
 * for weeks gets the full public alert instead.
 */
async function outTonight(o: { players: Player[]; report: Map<number, InjuryReportEntry>; prev: Record<string, string>; now: number; skip: Set<number>; dry: boolean }): Promise<BreakingEvent[]> {
  const fresh = o.players.filter((p) => {
    const e = o.report.get(p.id);
    return p.team !== "FA" && (p.pctOwned ?? 0) >= TONIGHT_MIN_OWNED && isOut(e) && !o.prev[p.id]?.startsWith("out:") && !o.skip.has(p.id) && !NOT_INJURY.test(`${e!.injury ?? ""} ${e!.note}`);
  });
  if (!fresh.length) return [];
  const today = easternDate(o.now);
  const games = await tipoffs(today);
  const kv = kvStore();
  const out: BreakingEvent[] = [];
  for (const p of fresh) {
    const g = games.get(p.team);
    if (!g || g.started || g.tip - o.now < TONIGHT_LEAD_MS) continue;
    const pickups = pickupsFor(p, o.players, o.report);
    if (!pickups.length || (o.dry && (await kv.get(`breaking:tonight:${today}:${p.id}`)))) continue;
    const e = o.report.get(p.id)!;
    out.push({ player: { id: p.id, name: p.name, team: p.team, pctOwned: Math.round(p.pctOwned ?? 0) }, injury: e.injury, note: e.note, pickups: pickups.slice(0, 3), source: "injury report", tonight: { opp: g.opp, tip: g.tip } });
  }
  return out;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const shortDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** The alert text; with the user's league, whether the pickup is free there and whether the player is theirs. */
interface LeagueView { rostered: Set<number>; mine: Set<number>; addUrl: string; snapshot: LeagueSnapshot; irPicks?: BackupPick[] }

export function alertText(ev: BreakingEvent, league?: LeagueView): string {
  const back = ev.returnDate ? `, back around ${shortDate(ev.returnDate)}` : ", no timeline yet";
  const lines = [`🚨 <b>${esc(ev.player.name)} (${ev.player.team}) is out</b>${ev.injury ? ` (${esc(ev.injury.toLowerCase())})` : ""}${back}.`];
  if (ev.note) lines.push(`<i>${esc(ev.note)}</i>`);
  if (league?.mine.has(ev.player.id)) {
    lines.push("He's on your team: move him to IR when ESPN allows, to free the spot.");
    if (league.irPicks?.length) {
      lines.push(`\n<b>For the open spot</b> (best free agents in your league, by games ahead):`);
      for (const b of league.irPicks) lines.push(`• ${esc(b.name)} (${b.team}, ${b.pos}): ${b.games} games, ~${b.points} pts`);
    }
  }
  const free = league ? ev.pickups.filter((p) => !league.rostered.has(p.id)) : ev.pickups;
  const top = free[0];
  if (top) {
    lines.push(`\n<b>Pickup: ${esc(top.name)}</b>, about ${top.fppg} fantasy pts a game while he's out (+${top.minutes} min, ${top.pctOwned}% rostered).`);
    if (top.reason) lines.push(esc(top.reason));
    if (league) lines.push(`✅ Free in your league right now: <a href="${league.addUrl}">add him on ESPN</a>.`);
    const next = free[1];
    if (next) lines.push(`Also: ${esc(next.name)} (~${next.fppg} pts, +${next.minutes} min).`);
  } else if (league && ev.pickups.length) {
    lines.push(`\nThe main pickups (${ev.pickups.map((p) => esc(p.name)).join(", ")}) are already taken in your league.`);
  }
  if (!league) lines.push(`\nSee if he's free in your league: ${SITE.replace(/^https?:\/\//, "")}`);
  return lines.join("\n");
}

/** Send each event to the owner chats, every linked Telegram user with news on, and email for the biggest names. */
export async function sendBreaking(events: BreakingEvent[], now = Date.now()): Promise<{ telegram: number; email: number }> {
  if (!events.length) return { telegram: 0, email: 0 };
  const kv = kvStore();
  const profiles = await listProfiles();
  const paid = new Set((await withAccess(profiles)).map((p) => p.email));
  // A paying user's league: who's rostered (pickups taken) and who's theirs.
  const leagues = new Map<string, LeagueView>();
  for (const p of profiles.filter((x) => paid.has(x.email) && (x.telegram || x.alerts.email))) {
    const ctx = await profileContext(p).catch(() => null);
    const snap = ctx ? await ctx.storage.getLatestSnapshot(ctx.leagueId, ctx.seasonId).catch(() => null) : null;
    if (!snap) continue;
    const rostered = new Set(snap.teams.flatMap((t) => (t.roster ?? []).map((r) => r.player.id)));
    const mine = new Set((snap.teams.find((t) => t.id === p.teamId)?.roster ?? []).map((r) => r.player.id));
    leagues.set(p.email, { rostered, mine, addUrl: espnAddUrl(p.leagueId, p.teamId), snapshot: snap });
  }
  // One of your own players out: the IR spot's best pickups from your league's free agents.
  let vctx: ValueContext | null = null;
  const withIr = async (ev: BreakingEvent, view?: LeagueView): Promise<LeagueView | undefined> => {
    if (!view?.mine.has(ev.player.id)) return view;
    vctx ??= await valueContext(now);
    const injured = vctx.byId.get(ev.player.id);
    const plan = await backupPlan(view.snapshot, { ctx: vctx, positions: injured?.pos, now }).catch(() => null);
    return { ...view, irPicks: plan?.top };
  };
  const wants = (p: InseasonProfile) => p.alerts.news !== false;
  let telegram = 0, email = 0;
  const sentTo = new Set<number>();
  for (const ev of events) {
    if (TELEGRAM_ON) {
      for (const p of profiles.filter((x) => x.telegram && wants(x))) {
        if (await sendTelegramTo(p.telegram!.chatId, alertText(ev, await withIr(ev, leagues.get(p.email))))) { telegram++; sentTo.add(p.telegram!.chatId); }
      }
      for (const chat of (await kv.get<number[]>(OWNER_CHATS)) ?? []) {
        if (!sentTo.has(chat) && (await sendTelegramTo(chat, alertText(ev)))) telegram++;
      }
    }
    if (EMAIL_ON && ev.player.pctOwned >= EMAIL_MIN_OWNED) {
      for (const p of profiles.filter((x) => x.alerts.email && wants(x))) {
        // One breaking email per person per day at most.
        if (!(await kv.claim(`breaking:email:${p.email}:${easternDate(now)}`, now))) continue;
        const html = alertText(ev, await withIr(ev, leagues.get(p.email))).replace(/\n/g, "<br>");
        const text = html.replace(/<[^>]+>/g, "");
        if (await sendEmail(p.email, { subject: `${ev.player.name} is out: who to pick up`, html, text })) email++;
        else await kv.delete(`breaking:email:${p.email}:${easternDate(now)}`).catch(() => {});
      }
    }
  }
  return { telegram, email };
}

/** The data behind a breaking card (/api/card/social?type=breaking), kept while the post is fresh. */
export const breakingCardKey = (id: number) => `breaking:card:${id}`;

/** Shams-style: the news in one plain line, then the fantasy move. */
export function breakingCaption(ev: BreakingEvent): string {
  if (ev.tonight) {
    const top = ev.pickups[0];
    const fill = top ? `\n\nDaily lineups: ${top.name} (${top.pctOwned}% rostered) gets about ${top.minutes} more minutes tonight.` : "";
    return `🚨 ${ev.player.name} (${ev.player.team}) is out tonight vs ${ev.tonight.opp}${ev.injury ? ` (${ev.injury.toLowerCase()})` : ""}.${fill}\n\n${CTA}\n${TAGS}`;
  }
  const back = ev.returnDate ? `, back around ${shortDate(ev.returnDate)}` : ", no timeline yet";
  const top = ev.pickups[0];
  const move = top ? `\n\nFantasy move: pick up ${top.name} (${top.pctOwned}% rostered), about ${top.fppg} fpts a game while he's out (+${top.minutes} min).${top.reason ? ` ${top.reason}` : ""}` : "";
  return `🚨 ${ev.player.name} (${ev.player.team}) is out${ev.injury ? ` (${ev.injury.toLowerCase()})` : ""}${back}.${ev.note ? `\n\n${ev.note}` : ""}${move}\n\n${CTA}\n${TAGS}`;
}

/**
 * The biggest alerts also go out publicly, right away, to Instagram, Threads and X: the fastest
 * fantasy news with the pickup attached is what gets an account followed. At most two a day.
 */
export async function postBreaking(events: BreakingEvent[], now = Date.now()): Promise<string[]> {
  const kv = kvStore();
  const today = easternDate(now);
  const posted: string[] = [];
  for (const ev of events.filter((e) => e.player.pctOwned >= POST_MIN_OWNED && e.longTerm && e.pickups.length).sort((a, b) => b.player.pctOwned - a.player.pctOwned)) {
    let slot = -1;
    for (let i = 0; i < POSTS_PER_DAY && slot < 0; i++) if (await kv.claim(`breaking:post:${today}:${i}`, ev.player.id)) slot = i;
    if (slot < 0) break;
    await kv.set(breakingCardKey(ev.player.id), { ...ev, at: now });
    const ok = await sendToPostroom({
      key: `breaking-alert:${today}:${ev.player.id}`, kind: "breaking", caption: breakingCaption(ev), postroomOnly: true, replies: true,
      images: [cardUrl(`type=breaking&player=${ev.player.id}&v=${today}`)],
    });
    if (ok) posted.push(ev.player.name);
    else await kv.delete(`breaking:post:${today}:${slot}`).catch(() => {});
  }
  return posted;
}

/** Ruled out tonight: posted right away, and dropped by Postroom if it isn't out before tip-off. */
export async function postTonight(events: BreakingEvent[], now = Date.now()): Promise<string[]> {
  const kv = kvStore();
  const today = easternDate(now);
  const posted: string[] = [];
  for (const ev of events.filter((e) => e.tonight).sort((a, b) => b.player.pctOwned - a.player.pctOwned)) {
    if (!(await kv.claim(`breaking:tonight:${today}:${ev.player.id}`, now))) continue;
    let slot = -1;
    for (let i = 0; i < TONIGHT_PER_DAY && slot < 0; i++) if (await kv.claim(`breaking:tonightSlot:${today}:${i}`, ev.player.id)) slot = i;
    if (slot < 0) break;
    await kv.set(breakingCardKey(ev.player.id), { ...ev, at: now });
    const ok = await sendToPostroom({
      key: `breaking-tonight:${today}:${ev.player.id}`, kind: "breaking", caption: breakingCaption(ev), postroomOnly: true, replies: true,
      images: [cardUrl(`type=breaking&player=${ev.player.id}&v=${today}-t`)], now: true, expiresAt: ev.tonight!.tip,
    });
    if (ok) posted.push(ev.player.name);
    else await Promise.all([kv.delete(`breaking:tonightSlot:${today}:${slot}`), kv.delete(`breaking:tonight:${today}:${ev.player.id}`)]).catch(() => {});
  }
  return posted;
}
