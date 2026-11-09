import { kvStore } from "./inseason/storage";

/**
 * Injury history from game logs: for each of a player's last three seasons, the games his team
 * played while he was on it vs the games he played, with the missed games grouped into absences.
 * That separates one long injury (a single long absence, healthy otherwise) from a player who sits
 * every other week (many short absences), which the value model treats differently.
 */

const WEB = "https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba";
const SITE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
/** Absences this long are one big injury. */
const LONG_ABSENCE = 10;

export interface SeasonHealth {
  season: number;
  played: number;
  /** Team games while he was on the roster (from his first team's opener to his last game). */
  teamGames: number;
  /** Games in each absence, longest first. */
  absences: number[];
  /** Minutes a game when he played, to tell rotation players from bench players. */
  min: number;
}
export type HealthLabel = "durable" | "one-off" | "in-and-out" | "unknown";
export interface HealthProfile {
  id: number;
  seasons: SeasonHealth[];
  /** Share of team games played. */
  availability: number;
  /** The same with long absences (one-off injuries) taken out. */
  baseline: number;
  /** Short absences (1-9 games) per 82 team games. */
  shortPer82: number;
  label: HealthLabel;
  builtAt: number;
}

async function getJson(url: string) {
  const r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`ESPN ${r.status} ${url}`);
  return r.json();
}

const scheduleCache = new Map<string, Promise<number[]>>();
/** Completed regular-season game times for a team. */
function teamGames(teamId: string, season: number): Promise<number[]> {
  const key = `${teamId}:${season}`;
  if (!scheduleCache.has(key)) {
    scheduleCache.set(key, getJson(`${SITE}/teams/${teamId}/schedule?season=${season}&seasontype=2`).then((j) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((j.events ?? []) as any[]).filter((e) => e.competitions?.[0]?.status?.type?.completed).map((e) => Date.parse(e.date)).sort((a, b) => a - b),
    ));
  }
  return scheduleCache.get(key)!;
}

async function seasonHealth(id: number, season: number): Promise<SeasonHealth | null> {
  const j = await getJson(`${WEB}/athletes/${id}/gamelog?season=${season}`).catch(() => null);
  const reg = j?.seasonTypes?.find((s: { displayName?: string }) => /^\d{4}-\d{2} Regular Season$/.test(s.displayName ?? ""));
  if (!reg) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ids = new Set<string>((reg.categories ?? []).flatMap((c: any) => (c.events ?? []).map((e: any) => String(e.eventId))));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const games = [...ids].map((eid) => j.events?.[eid]).filter(Boolean).map((e: any) => ({ t: Date.parse(e.gameDate), team: String(e.team?.id ?? "") })).sort((a, b) => a.t - b.t);
  if (!games.length) return null;
  const minIdx = (j.names ?? j.labels ?? []).indexOf?.("minutes") ?? -1;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mins: number[] = minIdx >= 0 ? (reg.categories ?? []).flatMap((c: any) => (c.events ?? []).map((e: any) => Number(e.stats?.[minIdx]) || 0)) : [];
  // Each stint with a team: from that team's game after his previous team's last game (or the
  // opener) to his last game with it; the last team runs to the end of the season.
  const teams = [...new Set(games.map((g) => g.team))];
  let teamTotal = 0;
  const missedRuns: number[] = [];
  for (const [i, team] of teams.entries()) {
    const mine = games.filter((g) => g.team === team);
    const sched = await teamGames(team, season).catch(() => [] as number[]);
    if (!sched.length) continue;
    const start = i === 0 ? sched[0] : mine[0].t;
    const end = i === teams.length - 1 ? sched[sched.length - 1] : mine[mine.length - 1].t;
    const window = sched.filter((t) => t >= start - 6 * 3600e3 && t <= end + 6 * 3600e3);
    teamTotal += window.length;
    const played = new Set(mine.map((g) => Math.round(g.t / 864e5)));
    let run = 0;
    for (const t of window) {
      if (played.has(Math.round(t / 864e5))) { if (run) missedRuns.push(run); run = 0; } else run++;
    }
    if (run) missedRuns.push(run);
  }
  return {
    season, played: games.length, teamGames: Math.max(teamTotal, games.length), absences: missedRuns.sort((a, b) => b - a),
    min: mins.length ? Math.round((mins.reduce((s, x) => s + x, 0) / mins.length) * 10) / 10 : 0,
  };
}

/** Seasons as a bench player (under 18 minutes) don't count: missed games are mostly coach's decisions. */
const ROTATION_MIN = 18;
/** Newest season first. */
const RECENCY = [0.5, 0.3, 0.2];

async function healthProfile(id: number, seasons: number[]): Promise<HealthProfile> {
  const list = (await Promise.all(seasons.map((s) => seasonHealth(id, s)))).filter((s): s is SeasonHealth => !!s);
  const used = list.filter((x) => x.min >= ROTATION_MIN && x.teamGames >= 20).sort((a, b) => b.season - a.season);
  const ws = used.map((_, i) => RECENCY[i] ?? 0.1), wsum = ws.reduce((a, b) => a + b, 0) || 1;
  const avg = (f: (x: SeasonHealth) => number) => used.reduce((s, x, i) => s + f(x) * ws[i], 0) / wsum;
  const longOf = (x: SeasonHealth) => x.absences.filter((a) => a >= LONG_ABSENCE).reduce((a, b) => a + b, 0);
  const availability = used.length ? avg((x) => x.played / x.teamGames) : 0;
  const baseline = used.length ? avg((x) => (x.teamGames - longOf(x) > 0 ? Math.min(1, x.played / (x.teamGames - longOf(x))) : 1)) : 0;
  const shortPer82 = used.length ? avg((x) => (x.absences.filter((a) => a < LONG_ABSENCE).length / x.teamGames) * 82) : 0;
  const games = used.reduce((s, x) => s + x.teamGames, 0);
  const label: HealthLabel = games < 40 ? "unknown" : shortPer82 >= 6 || baseline < 0.82 ? "in-and-out" : availability < 0.8 ? "one-off" : "durable";
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return { id, seasons: list, availability: r2(availability), baseline: r2(baseline), shortPer82: Math.round(shortPer82 * 10) / 10, label, builtAt: Date.now() };
}

const KEY = "value:health";
export const loadHealth = async () => (await kvStore().get<Record<string, HealthProfile>>(KEY).catch(() => null)) ?? {};

/** Build or refresh profiles for these players (a few at a time, ESPN is slow), keeping the rest. */
export async function refreshHealth(ids: number[], seasons: number[], opts: { maxAgeDays?: number; limit?: number } = {}): Promise<number> {
  const all = await loadHealth();
  const stale = ids.filter((id) => !all[id] || Date.now() - all[id].builtAt > (opts.maxAgeDays ?? 30) * 864e5).slice(0, opts.limit ?? Infinity);
  for (let i = 0; i < stale.length; i += 6) {
    const batch = await Promise.all(stale.slice(i, i + 6).map((id) => healthProfile(id, seasons).catch(() => null)));
    for (const p of batch) if (p) all[p.id] = p;
  }
  if (stale.length) await kvStore().set(KEY, all);
  return stale.length;
}
