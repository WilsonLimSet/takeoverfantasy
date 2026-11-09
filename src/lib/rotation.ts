import { getPlayers } from "./data";
import { kvStore } from "./inseason/storage";
import { NBA_TEAMS } from "./inseason/espnClient";
import { currentPeriod } from "./inseason/matchupGames";
import type { LeagueSnapshot } from "@/types";
import { boxLines, easternDate } from "./social";
import type { Player } from "./types";
import { valueContext, valuePlayer } from "./value";
import type { LeagueRotationEntry, RotationEntry, RotationReport } from "./rotationKinds";
export * from "./rotationKinds";

/**
 * What coaches are doing with their rotations, from the nightly box scores (`social:minutes:<date>`,
 * `social:fpts:<date>`, `social:dnp:<date>`): his last few games against the ones before. Season
 * averages lag: a player who jumped from 0 to 30 minutes three games ago still averages 12, and one
 * who fell out of the rotation still averages 25. This catches both the next morning.
 *  - up: minutes jumped (a new starter, a closing role), with the injured teammate behind it if any.
 *  - opening: a regular is out with a return date and the minutes split says this player gains.
 *  - down: a regular whose minutes fell while healthy.
 *  - benched: a regular sat by the coach (DNP coach's decision) or under 8 minutes in 2 of his last 3.
 *  - grown: not a sudden jump, but his minutes for weeks are far above the preseason projection, and
 *    most leagues still haven't picked him up.
 *  - news: the AI's read of his news (autoTakes) moves his role, before the box scores show it.
 * Games he missed hurt, resting or not dressed don't count either way: that's not his role.
 */

const NIGHTS = 16;
/** Games that count as "now". */
const RECENT = 3;
const DAY = 864e5;
/** Rebuilt every couple of hours: late games finish, and injuries (the openings) change during the day. */
const REBUILD_MS = 2 * 60 * 60 * 1000;
const CACHE_KEY = "rotation:latest";

interface Night { date: string; min: Record<string, number>; fpts: Record<string, number>; dnp: Record<string, string> | null }
/** One team game: minutes (0 = benched by the coach), or null when he wasn't available. */
interface Game { min: number | null; fpts: number }

const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const r1 = (x: number) => Math.round(x * 10) / 10;
const OUT = /out|injur|suspen/i;
const COACH = /coach/i;
const dayName = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** Each player's team games in the window, newest first. */
function gameLogs(players: Player[], nights: Night[]): Map<number, Game[]> {
  const teamOf = new Map(players.map((p) => [p.id, p.team]));
  const played = nights.map((n) => new Set(Object.keys(n.min).map((id) => teamOf.get(Number(id))).filter(Boolean)));
  const out = new Map<number, Game[]>();
  for (const p of players) {
    if (p.team === "FA") continue;
    const games: Game[] = [];
    nights.forEach((n, i) => {
      if (!played[i].has(p.team)) return;
      const min = n.min[p.id];
      if (min > 0) games.push({ min, fpts: n.fpts[p.id] ?? 0 });
      // Sat by the coach counts as 0. Hurt, resting, or not in the box at all: not about his role.
      else if (n.dnp && COACH.test(n.dnp[p.id] ?? "")) games.push({ min: 0, fpts: 0 });
      else games.push({ min: null, fpts: 0 });
    });
    out.set(p.id, games);
  }
  return out;
}

type Dep = { name: string; until: string; minutes: number };
type News = { headline: string; date: string; factor: number };

function classify(p: Player, games: Game[], hurt: boolean, now: number, dep?: Dep, news?: News): Omit<RotationEntry, "id" | "name" | "team" | "pos" | "pctOwned"> | null {
  const avail = games.filter((g): g is { min: number; fpts: number } => g.min !== null);
  if (avail.length < RECENT) return null;
  const recent = avail.slice(0, RECENT);
  const earlier = avail.slice(RECENT);
  const season = p.cur?.min ?? 0;
  const before = earlier.length >= 3 ? avg(earlier.map((g) => g.min)) : season || (p.last?.min ?? 0);
  const now3 = avg(recent.map((g) => g.min));
  const playedRecent = recent.filter((g) => g.min > 0);
  const playedEarlier = earlier.filter((g) => g.min > 0);
  const fptsRecent = avg(playedRecent.map((g) => g.fpts));
  const fptsBefore = avg(playedEarlier.map((g) => g.fpts));
  const base = { recent: recent.map((g) => r1(g.min)), before: r1(before), season: r1(season), fptsRecent: r1(fptsRecent), fptsBefore: r1(fptsBefore) };
  if (hurt) return null;

  // Up: a real jump, also above his season average (which already includes the new games).
  if (playedRecent.length === RECENT && now3 >= 22 && now3 - before >= 7 && now3 - season >= 4) {
    const usage = fptsBefore > 0 && fptsRecent >= fptsBefore * 1.3 ? ` and ${Math.round(fptsRecent)} fantasy pts a game (from ${Math.round(fptsBefore)})` : "";
    return {
      ...base, kind: "up", because: dep,
      note: `${Math.round(now3)} min the last 3 games, up from ${Math.round(before)}${usage}.${dep ? ` ${dep.name} is out (back about ${dayName(dep.until)}), so it may not last.` : " No injured teammate behind it: the coach has changed his role."}`,
    };
  }
  // Only openings that last a few days: one ending tomorrow isn't worth an add.
  if (dep && dep.minutes >= 5 && Date.parse(`${dep.until}T12:00:00Z`) - now >= 3 * DAY) {
    // An opening the games haven't shown yet (the injury is new) or a bump under the "up" cut.
    return { ...base, kind: "opening", because: dep, note: `About +${Math.round(dep.minutes)} min a game while ${dep.name} is out (back about ${dayName(dep.until)}).` };
  }
  // A role that grew weeks ago: steady minutes far above what he was projected for, still widely available.
  const proj = p.proj?.min ?? 0;
  const now5 = avg(avail.slice(0, 5).map((g) => g.min));
  if (proj > 0 && now3 >= 24 && now5 - proj >= 8 && (p.pctOwned ?? 0) < 50 && avail.slice(0, 5).every((g) => g.min >= 15)) {
    return { ...base, kind: "grown", because: dep, note: `${Math.round(now5)} min a game lately; he was projected for ${Math.round(proj)}. The bigger role has held${dep ? `, though ${dep.name} being out (back about ${dayName(dep.until)}) helps` : ""}.` };
  }
  // News of a role change the games don't show yet (a new starter, a demotion).
  if (news && Math.abs(news.factor - 1) >= 0.1) {
    return { ...base, kind: "news", headline: news.headline, note: `${news.factor > 1 ? "Role up" : "Role down"} in the news (${dayName(news.date.slice(0, 10))}): ${news.headline}` };
  }
  const usual = Math.max(before, season);
  if (usual < 18) return null;
  const sat = recent.filter((g) => g.min < 8).length;
  if (sat >= 2) {
    return {
      ...base, kind: "benched",
      note: `Healthy, but ${recent.map((g) => (g.min > 0 ? `${Math.round(g.min)} min` : "DNP (coach)")).join(", ")} the last 3 games after ${Math.round(usual)} a game. Out of the rotation for now.`,
    };
  }
  // Down: compared with games he played, so one blowout or foul-out doesn't flag him.
  const now3Played = avg(playedRecent.map((g) => g.min));
  if (before - now3Played >= 7 && season - now3Played >= 5) {
    return {
      ...base, kind: "down",
      note: `${Math.round(now3Played)} min the last 3 games, down from ${Math.round(before)}${season > before + 2 ? ` (${Math.round(season)} on the season)` : ""}. His season average hides it.`,
    };
  }
  // A slower slide over 4 games (a teammate eating into his role a few minutes a night).
  const last4 = avail.slice(0, 4).filter((g) => g.min > 0);
  const prior4 = avail.slice(4).filter((g) => g.min > 0);
  if (last4.length === 4 && prior4.length >= 3) {
    const now4 = avg(last4.map((g) => g.min)), was = avg(prior4.map((g) => g.min));
    if (was - now4 >= 6 && season - now4 >= 4) {
      return {
        ...base, kind: "down",
        note: `${Math.round(now4)} min the last 4 games (${last4.map((g) => Math.round(g.min)).join(", ")}), down from ${Math.round(was)} before. Sliding, and his season average hides it.`,
      };
    }
  }
  return null;
}

export async function rotationReport(now = Date.now()): Promise<RotationReport | null> {
  const kv = kvStore();
  // The last build, if it's recent: one read instead of 48 and a live box-score fetch.
  const hit = await kv.get<RotationReport>(CACHE_KEY).catch(() => null);
  if (hit && now - hit.builtAt < REBUILD_MS && now >= hit.builtAt) return hit;
  const dates = Array.from({ length: NIGHTS }, (_, i) => easternDate(now - (i + 1) * DAY));
  const load = (d: string) => Promise.all([
    kv.get<Record<string, number>>(`social:minutes:${d}`).catch(() => null),
    kv.get<Record<string, number>>(`social:fpts:${d}`).catch(() => null),
    kv.get<Record<string, string>>(`social:dnp:${d}`).catch(() => null),
  ]);
  const saved = await Promise.all(dates.map(load));
  // Last night isn't saved until the morning run (15:00 UTC); read its finished games straight from
  // the box scores so a benching shows up the morning after, not a day later. Not saved here: the
  // morning run saves it and scores the predictions once.
  if (!saved[0][0]) {
    const b = await boxLines(dates[0]).catch(() => null);
    if (b?.lines.length) saved[0] = [Object.fromEntries(b.lines.map((l) => [l.id, l.min])), Object.fromEntries(b.lines.map((l) => [l.id, l.fpts])), b.dnp];
  }
  const first = saved.findIndex(([m]) => m && Object.keys(m).length);
  if (first < 0) return null;
  const night = dates[first];

  const nights: Night[] = dates
    .map((date, i) => ({ date, min: saved[i][0] ?? {}, fpts: saved[i][1] ?? {}, dnp: saved[i][2] }))
    .filter((n) => Object.keys(n.min).length);
  const [{ players }, vctx] = await Promise.all([getPlayers(), valueContext(now)]);
  const logs = gameLogs(players, nights);
  const entries: RotationEntry[] = [];
  for (const p of players) {
    const games = logs.get(p.id);
    if (!games) continue;
    const inj = vctx.injuries.get(p.id);
    const hurt = !!(inj && OUT.test(inj.status)) || p.injury !== "ACTIVE";
    const v = hurt ? undefined : valuePlayer(p, vctx);
    const dep = v?.dependsOn[0];
    // Only fresh news: an old read is already in his minutes.
    const news = v?.news && now - Date.parse(v.news.date) < 7 * DAY ? v.news : undefined;
    const c = classify(p, games, hurt, now, dep && { name: dep.name, until: dep.until, minutes: dep.minutes }, news);
    if (c) entries.push({ id: p.id, name: p.name, team: p.team, pos: p.pos.join("/"), pctOwned: Math.round(p.pctOwned ?? 0), ...c });
  }
  // Who's taking the minutes: a teammate whose role is growing at the same time.
  for (const e of entries) {
    if (e.kind !== "down" && e.kind !== "benched") continue;
    const takers = entries.filter((x) => x.team === e.team && (x.kind === "up" || x.kind === "grown"));
    if (takers.length) e.note += ` Meanwhile ${takers.map((x) => `${x.name} is up to ${Math.round(avg(x.recent))}`).join(" and ")}.`;
  }
  const report: RotationReport = { night, builtAt: now, entries };
  await kv.set(CACHE_KEY, report).catch(() => {});
  return report;
}

const TEAM_ID = new Map(Object.entries(NBA_TEAMS).map(([id, t]) => [t.abbrev, Number(id)]));

/** The report in one league: whose each player is, and his games left this week and next. */
export function placeInLeague(report: RotationReport, snapshot: LeagueSnapshot | null): LeagueRotationEntry[] {
  const owner = new Map<number, { mine: boolean; name: string }>();
  for (const t of snapshot?.teams ?? []) for (const r of t.roster ?? []) owner.set(r.player.id, { mine: t.id === snapshot!.myTeamId, name: t.name });
  const waivers = new Set((snapshot?.freeAgentsTopN ?? []).filter((f) => f.onWaivers).map((f) => f.player.id));
  const today = snapshot ? currentPeriod(snapshot) : 0;
  return report.entries.map((e) => {
    const o = owner.get(e.id);
    const team = TEAM_ID.get(e.team);
    const week = team !== undefined ? snapshot?.matchupWeek?.teamGames[team] : undefined;
    const next = team !== undefined ? snapshot?.nextMatchupWeek?.teamGames[team] : undefined;
    return {
      ...e,
      where: o ? (o.mine ? "mine" : "taken") : waivers.has(e.id) ? "waivers" : "free",
      owner: o && !o.mine ? o.name : undefined,
      gamesLeft: week ? week.filter((p) => p >= today).length : undefined,
      gamesNext: next?.length,
    };
  });
}
