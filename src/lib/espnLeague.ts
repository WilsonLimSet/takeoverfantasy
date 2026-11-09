import { SEASON } from "./data";
import type { Cat, League, PointsScoring, Slot } from "./engine";
import type { StatKey } from "./types";

const BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons";

// ESPN scoring stat id -> our stat key (points leagues)
const POINTS_STAT: Record<number, StatKey> = {
  0: "pts", 1: "blk", 2: "stl", 3: "ast", 4: "oreb", 5: "dreb", 6: "reb", 11: "tov",
  13: "fgm", 14: "fga", 15: "ftm", 16: "fta", 17: "tpm", 18: "tpa", 37: "dd", 38: "td", 40: "min",
};
// Missed shots (FGMI, FTMI, 3PMI) -> [attempts, makes]
const MISSED_STAT: Record<number, [StatKey, StatKey]> = { 23: ["fga", "fgm"], 24: ["fta", "ftm"], 25: ["tpa", "tpm"] };
// ESPN scoring stat id -> our category (category leagues)
const CAT_STAT: Record<number, Cat> = {
  0: "pts", 1: "blk", 2: "stl", 3: "ast", 4: "oreb", 6: "reb", 11: "tov", 17: "tpm", 19: "fg%", 20: "ft%", 37: "dd",
};
const STAT_LABEL: Record<number, string> = {
  5: "DREB", 7: "EJ", 8: "FF", 9: "PF", 10: "TF", 12: "DQ", 13: "FGM", 14: "FGA", 15: "FTM", 16: "FTA", 18: "3PA",
  19: "FG%", 20: "FT%", 21: "3P%", 22: "AFG%", 35: "A/TO", 36: "STL/TO", 38: "TD", 39: "QD", 40: "MIN", 41: "GS",
  42: "GP", 43: "TW",
};
// ESPN lineup slot id -> our slot. Hybrid slots we don't model (SG/SF, G/F, PF/C, F/C) count as UT.
const LINEUP_SLOT: Record<number, Slot> = {
  0: "PG", 1: "SG", 2: "SF", 3: "PF", 4: "C", 5: "G", 6: "F", 7: "UT", 8: "UT", 9: "UT", 10: "UT", 11: "UT",
};
const BENCH_SLOT = 12;

export class EspnLeagueError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

interface EspnAuth { s2: string; swid: string }

/**
 * A visitor's ESPN login cookies, sent by our own client as headers for a private league. They are
 * used for this one request to ESPN and never stored or logged.
 */
export function requestAuth(req: Request): EspnAuth | null {
  return checkAuth(req.headers.get("x-espn-s2") ?? "", req.headers.get("x-espn-swid") ?? "");
}

/** Validate pasted ESPN cookies (null when both are blank). */
export function checkAuth(rawS2: string, rawSwid: string): EspnAuth | null {
  const s2 = rawS2.trim(), swid = rawSwid.trim();
  if (!s2 && !swid) return null;
  const s2ok = /^[A-Za-z0-9%+/=]{40,1000}$/.test(s2);
  const swidOk = /^\{?[0-9A-Fa-f-]{36}\}?$/.test(swid);
  if (!s2ok || !swidOk) throw new EspnLeagueError("Those don't look like ESPN cookies. espn_s2 is a long string; SWID looks like {XXXXXXXX-XXXX-...}.", 400);
  return { s2, swid: swid.startsWith("{") ? swid : `{${swid}}` };
}

/**
 * Leagues the server's ESPN cookies may be used for: your league, plus any older leagues listed in
 * ESPN_HISTORY_LEAGUE_IDS (e.g. last season's league if your league was recreated this year).
 */
export function ownLeagueIds(): string[] {
  return [process.env.ESPN_LEAGUE_ID, ...(process.env.ESPN_HISTORY_LEAGUE_IDS ?? "").split(",")]
    .map((x) => (x ?? "").trim()).filter((x) => /^\d+$/.test(x));
}

/** League id and season from a request, falling back to the owner's env league and the draft season. */
export function leagueParams(req: Request) {
  const q = new URL(req.url).searchParams;
  const leagueId = (q.get("leagueId") ?? process.env.ESPN_LEAGUE_ID ?? "").trim();
  const season = Number(q.get("season") ?? SEASON);
  if (!/^\d{1,12}$/.test(leagueId)) throw new EspnLeagueError("Enter your ESPN league ID (the number after leagueId= in the league URL).", 400);
  if (!Number.isInteger(season) || season < 2018 || season > 2100) throw new EspnLeagueError("Bad season.", 400);
  return { leagueId, season };
}

/**
 * Fetch league views from ESPN. The owner's cookies (ESPN_S2 / ESPN_SWID) are only sent for the
 * owner's own league (ESPN_LEAGUE_ID), so this endpoint can't be used to read other private leagues.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchLeague(leagueId: string, season: number, views: string[], auth: EspnAuth | null = null): Promise<any> {
  const url = `${BASE}/${season}/segments/0/leagues/${leagueId}?${views.map((v) => `view=${v}`).join("&")}`;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "Mozilla/5.0 (compatible; TakeoverFantasy/0.1)",
  };
  // A visitor's own cookies (sent with this request) work for any league they can see; the
  // server's cookies only for the owner's leagues.
  const { ESPN_S2: s2, ESPN_SWID: swid } = process.env;
  const own = !!(s2 && swid && ownLeagueIds().includes(leagueId));
  const authed = !!auth || own;
  if (auth) headers.Cookie = `espn_s2=${auth.s2}; SWID=${auth.swid}`;
  else if (own) headers.Cookie = `espn_s2=${s2}; SWID=${swid}`;
  const r = await fetch(url, { headers, cache: "no-store", redirect: "manual" });
  if (r.status === 401 || r.status === 403 || (r.status >= 300 && r.status < 400)) {
    throw new EspnLeagueError(
      auth
        ? "ESPN rejected your cookies. Copy fresh espn_s2 and SWID values (they change when you log out of ESPN)."
        : authed
          ? "ESPN rejected the server's cookies. Refresh ESPN_S2 and ESPN_SWID."
          : "This league is private. Add your ESPN cookies (espn_s2 and SWID) under League Settings → Import from ESPN.",
      401,
    );
  }
  if (r.status === 404) throw new EspnLeagueError(`ESPN has no league ${leagueId} for the ${season - 1}-${String(season).slice(2)} season yet.`, 404);
  if (!r.ok) throw new EspnLeagueError(`ESPN returned HTTP ${r.status}.`, 502);
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new EspnLeagueError("ESPN returned a non-JSON response.", 502);
  }
}

interface DraftSync {
  leagueId: string;
  season: number;
  drafted: boolean;
  inProgress: boolean;
  /** ESPN player ids in overall pick order. */
  picks: number[];
  detail: { overall: number; round: number; roundPick: number; teamId: number; playerId: number }[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseDraft(json: any, leagueId: string, season: number): DraftSync {
  const d = json?.draftDetail ?? {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const made = ((d.picks ?? []) as any[])
    .filter((p) => Number(p?.playerId) > 0)
    .sort((a, b) => Number(a.overallPickNumber) - Number(b.overallPickNumber));
  const detail = made.map((p) => ({
    overall: Number(p.overallPickNumber),
    round: Number(p.roundId),
    roundPick: Number(p.roundPickNumber),
    teamId: Number(p.teamId),
    playerId: Number(p.playerId),
  }));
  // Index = overall pick - 1, so a pick ESPN doesn't show (e.g. a keeper) leaves a 0 placeholder
  // instead of shifting every later pick to the wrong team.
  const last = detail.reduce((m, p) => (Number.isFinite(p.overall) ? Math.max(m, p.overall) : m), 0);
  const picks = last >= detail.length ? Array<number>(last).fill(0) : detail.map((p) => p.playerId);
  if (last >= detail.length) for (const p of detail) if (p.overall >= 1) picks[p.overall - 1] = p.playerId;
  return {
    leagueId, season,
    drafted: !!d.drafted,
    inProgress: !!d.inProgress,
    picks,
    detail,
  };
}

export interface EspnLeagueSettings {
  leagueId: string;
  season: number;
  name: string;
  scoringType: string;
  /** Ready to merge into the app's League settings. */
  league: Pick<League, "format" | "scoring" | "cats" | "teams" | "slots" | "bench">;
  /** Roster size without IR, which is the number of draft rounds. */
  rounds: number;
  /** 1-based draft slot of ESPN_MY_TEAM_ID, when the draft order is set. */
  mySlot: number | null;
  /** Things in the ESPN settings this app doesn't model. */
  notes: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseSettings(json: any, leagueId: string, season: number, swid?: string): EspnLeagueSettings {
  const s = json?.settings;
  if (!s) throw new EspnLeagueError("ESPN's response had no league settings.", 502);
  const notes: string[] = [];
  const scoringType = String(s.scoringSettings?.scoringType ?? "");
  const format: League["format"] = scoringType.includes("POINTS") ? "points" : "cats";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items = (s.scoringSettings?.scoringItems ?? []) as any[];

  const scoring: PointsScoring = {};
  const cats: Cat[] = [];
  const unsupported: string[] = [];
  for (const it of items) {
    const id = Number(it.statId);
    if (format === "points") {
      const pts = Number(it.points ?? 0);
      if (!pts) continue;
      const k = POINTS_STAT[id];
      const missed = MISSED_STAT[id];
      const add = (key: StatKey, v: number) => { scoring[key] = (scoring[key] ?? 0) + v; };
      if (k) add(k, pts);
      else if (missed) { add(missed[0], pts); add(missed[1], -pts); } // misses = attempts - makes
      else unsupported.push(`${STAT_LABEL[id] ?? `stat ${id}`} (${pts > 0 ? "+" : ""}${pts})`);
    } else {
      const c = CAT_STAT[id];
      if (c) { if (!cats.includes(c)) cats.push(c); }
      else unsupported.push(STAT_LABEL[id] ?? `stat ${id}`);
    }
  }
  if (unsupported.length) notes.push(`Not modeled here, so ignored: ${unsupported.join(", ")}.`);
  // DREB and REB both scored: our projections carry both, so that works. Flag stats ESPN doesn't project.
  const unprojected = format === "points"
    ? scoring.dd || scoring.td || scoring.oreb || scoring.dreb
    : cats.some((c) => ["dd", "td", "oreb", "dreb"].includes(c));
  if (unprojected) notes.push("ESPN's preseason projections don't include OREB, DREB, DD or TD, so those use last season's numbers.");
  if (format === "points" && !Object.keys(scoring).length) notes.push("Couldn't read this league's point values, so check the scoring below.");
  if (format === "cats" && !cats.length) notes.push("Couldn't read this league's categories, so check them below.");

  const slots: Record<Slot, number> = { PG: 0, SG: 0, SF: 0, PF: 0, C: 0, G: 0, F: 0, UT: 0 };
  let bench = 0, hybrid = 0;
  for (const [id, n] of Object.entries((s.rosterSettings?.lineupSlotCounts ?? {}) as Record<string, number>)) {
    const count = Number(n) || 0;
    const slot = LINEUP_SLOT[Number(id)];
    if (slot) {
      slots[slot] += count;
      if ([7, 8, 9, 10].includes(Number(id))) hybrid += count;
    } else if (Number(id) === BENCH_SLOT) bench = count;
  }
  if (hybrid) notes.push(`${hybrid} hybrid slot${hybrid > 1 ? "s" : ""} (SG/SF, G/F, PF/C or F/C) counted as UTIL.`);
  const rounds = Object.values(slots).reduce((a, b) => a + b, 0) + bench;
  if (!rounds) notes.push("Couldn't read this league's roster slots, so check them below.");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const teams = Number(s.size) || ((json?.teams as any[] | undefined)?.length ?? 10);
  const order: number[] = s.draftSettings?.pickOrder ?? [];
  // Your team: the one your ESPN account owns, or ESPN_MY_TEAM_ID for the server owner's league.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const owned = swid ? ((json?.teams ?? []) as any[]).find((t) => (t.owners ?? []).includes(swid) || t.primaryOwner === swid) : null;
  const envTeam = process.env.ESPN_LEAGUE_ID?.trim() === leagueId ? Number(process.env.ESPN_MY_TEAM_ID) : NaN;
  const myTeam = owned ? Number(owned.id) : envTeam;
  const idx = myTeam ? order.indexOf(myTeam) : -1;
  if (s.draftSettings?.type && s.draftSettings.type !== "SNAKE") {
    notes.push(`Draft type is ${String(s.draftSettings.type).toLowerCase()}; the draft board assumes a snake draft.`);
  }

  return {
    leagueId, season,
    name: String(s.name ?? `League ${leagueId}`),
    scoringType,
    league: { format, scoring, cats, teams, slots, bench },
    rounds,
    mySlot: idx >= 0 ? idx + 1 : null,
    notes,
  };
}

/* ---------------- League scouting ---------------- */

const seasonLabel = (s: number) => `${s - 1}-${String(s).slice(2)}`;

export interface ScoutPick { season: number; round: number; overall: number; playerId: number; auto: boolean; keeper: boolean }
export interface ScoutManager {
  ownerId: string;
  /** This is you (matched by your ESPN account). */
  isMe?: boolean;
  name: string;
  /** This season's team, when the league has been renewed. */
  teamName: string | null;
  /** 1-based draft slot this season, when ESPN has set the order. */
  slot: number | null;
  /** This season's ESPN team id, used to match live draft picks to managers. */
  teamId: number | null;
  picks: ScoutPick[];
}
export interface Scouting {
  leagueId: string;
  season: number;
  seasonsLoaded: number[];
  managers: ScoutManager[];
  notes: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const memberName = (m: Json) => {
  const full = [m?.firstName, m?.lastName].filter(Boolean).join(" ").trim();
  return full || m?.displayName || "Unknown manager";
};
const teamName = (t: Json) => String(t?.name ?? [t?.location, t?.nickname].filter(Boolean).join(" ") ?? `Team ${t?.id}`).trim();

/**
 * Past drafts for every manager in a league, matched across seasons by ESPN owner id (team ids
 * and names change; owners don't). Used to anticipate who will take whom.
 */
export async function fetchScouting(
  leagueId: string, season: number, back = 2, historyLeagueIds: string[] = [], auth: EspnAuth | null = null,
): Promise<Scouting> {
  const notes: string[] = [];
  const managers = new Map<string, ScoutManager>();
  const get = (ownerId: string, name: string) =>
    managers.get(ownerId) ?? managers.set(ownerId, { ownerId, name, teamName: null, slot: null, teamId: null, picks: [] }).get(ownerId)!;

  // This season: who is in the league and the draft order.
  try {
    const cur: Json = await fetchLeague(leagueId, season, ["mTeam", "mSettings"], auth);
    const names = new Map<string, string>((cur.members ?? []).map((m: Json) => [m.id, memberName(m)]));
    const order: number[] = cur.settings?.draftSettings?.pickOrder ?? [];
    for (const t of cur.teams ?? []) {
      const owner = t.primaryOwner ?? t.owners?.[0];
      if (!owner) continue;
      const m = get(owner, names.get(owner) ?? teamName(t));
      m.teamName = teamName(t);
      m.teamId = Number(t.id);
      const idx = order.indexOf(t.id);
      m.slot = idx >= 0 ? idx + 1 : null;
    }
    if (!order.length) notes.push("ESPN hasn't set this season's draft order yet, so picks can't be matched to managers until it does.");
  } catch (e) {
    notes.push(`This season's league isn't available yet (${e instanceof Error ? e.message : e}). Showing past drafts only.`);
  }

  const seasonsLoaded: number[] = [];
  // Past drafts can live in this league or in an older league the same people played in.
  const sources = [leagueId, ...historyLeagueIds.filter((x) => x !== leagueId)];
  for (let s = season - 1; s >= season - back; s--) for (const src of sources) {
    try {
      const j: Json = await fetchLeague(src, s, ["mDraftDetail", "mTeam", "mSettings"], auth);
      const names = new Map<string, string>((j.members ?? []).map((m: Json) => [m.id, memberName(m)]));
      const ownerOf = new Map<number, string>();
      for (const t of j.teams ?? []) { const o = t.primaryOwner ?? t.owners?.[0]; if (o) ownerOf.set(t.id, o); }
      const picks: Json[] = j.draftDetail?.picks ?? [];
      if (!picks.length) continue;
      if (!seasonsLoaded.includes(s)) seasonsLoaded.push(s);
      if (src !== leagueId) notes.push(`${seasonLabel(s)} draft comes from your older league ${String(j.settings?.name ?? src).trim()} (${(j.teams ?? []).length} teams).`);
      for (const p of picks) {
        const owner = ownerOf.get(p.teamId);
        if (!owner || !(p.playerId > 0)) continue;
        get(owner, names.get(owner) ?? `Team ${p.teamId}`).picks.push({
          season: s, round: Number(p.roundId), overall: Number(p.overallPickNumber), playerId: Number(p.playerId),
          auto: Number(p.autoDraftTypeId ?? 0) > 0, keeper: !!p.keeper,
        });
      }
    } catch { /* that season isn't available; keep going */ }
  }
  if (!seasonsLoaded.length) notes.push("No past drafts found. If your league was recreated this season, set ESPN_HISTORY_LEAGUE_IDS to last season's league ID.");
  const me = auth?.swid ?? (ownLeagueIds().includes(leagueId) ? process.env.ESPN_SWID?.trim() : undefined);
  for (const m of managers.values()) if (me && m.ownerId === me) m.isMe = true;
  return { leagueId, season, seasonsLoaded, managers: [...managers.values()].filter((m) => m.picks.length || m.slot), notes };
}
