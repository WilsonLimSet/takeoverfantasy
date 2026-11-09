import { Player, PlayerBio, Pos, StatKey, StatLine, STAT_KEYS } from "./types";

// ESPN stat id -> our key (ids from ESPN's fantasy API, see cwendt94/espn-api)
const ESPN_STAT: Record<string, StatKey | "gp"> = {
  "0": "pts", "1": "blk", "2": "stl", "3": "ast", "4": "oreb", "5": "dreb",
  "6": "reb", "11": "tov", "13": "fgm", "14": "fga", "15": "ftm", "16": "fta",
  "17": "tpm", "18": "tpa", "37": "dd", "38": "td", "40": "min", "42": "gp",
};

export const PRO_TEAM: Record<number, string> = {
  0: "FA", 1: "ATL", 2: "BOS", 3: "NOP", 4: "CHI", 5: "CLE", 6: "DAL", 7: "DEN",
  8: "DET", 9: "GSW", 10: "HOU", 11: "IND", 12: "LAC", 13: "LAL", 14: "MIA",
  15: "MIL", 16: "MIN", 17: "BKN", 18: "NYK", 19: "ORL", 20: "PHI", 21: "PHX",
  22: "POR", 23: "SAC", 24: "SAS", 25: "OKC", 26: "UTA", 27: "WAS", 28: "TOR",
  29: "MEM", 30: "CHA",
};

const SLOT_POS: Record<number, Pos> = { 0: "PG", 1: "SG", 2: "SF", 3: "PF", 4: "C" };
const DEFAULT_POS: Record<number, Pos> = { 1: "PG", 2: "SG", 3: "SF", 4: "PF", 5: "C" };

type Dict = Record<string, number>;
interface EspnStatEntry {
  seasonId: number;
  statSourceId: number;
  statSplitTypeId: number;
  stats?: Dict;
  averageStats?: Dict;
}

/** Convert an ESPN season-split entry into a per-game line. */
function toLine(e: EspnStatEntry): StatLine | null {
  const totals = e.stats ?? {};
  const avg = e.averageStats;
  const gp = Number(totals["42"] ?? 0);
  const line = { gp } as StatLine;
  for (const k of STAT_KEYS) line[k] = 0;
  let any = false;
  for (const [id, key] of Object.entries(ESPN_STAT)) {
    if (key === "gp") continue;
    let v: number | undefined;
    if (avg && avg[id] != null) v = Number(avg[id]);
    else if (totals[id] != null && gp > 0) v = Number(totals[id]) / gp;
    if (v != null && Number.isFinite(v)) {
      line[key] = v;
      any = true;
    }
  }
  if (!any || gp <= 0) return null;
  if (!line.reb && (line.oreb || line.dreb)) line.reb = line.oreb + line.dreb;
  return line;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parsePlayers(json: any, season: number, outlooks?: Map<number, string>): Player[] {
  const out: Player[] = [];
  for (const wrap of json?.players ?? []) {
    const p = wrap.player ?? wrap;
    if (!p?.id || !p.fullName) continue;
    const stats: EspnStatEntry[] = p.stats ?? [];
    const find = (s: number, src: number) =>
      stats.find((e) => e.seasonId === s && e.statSourceId === src && e.statSplitTypeId === 0);
    const lastE = find(season - 1, 0);
    const projE = find(season, 1);
    const curE = find(season, 0);
    const pos = Array.from(
      new Set((p.eligibleSlots ?? []).map((s: number) => SLOT_POS[s]).filter(Boolean))
    ) as Pos[];
    if (!pos.length && DEFAULT_POS[p.defaultPositionId]) pos.push(DEFAULT_POS[p.defaultPositionId]);
    if (outlooks && typeof p.seasonOutlook === "string" && p.seasonOutlook.trim()) outlooks.set(p.id, p.seasonOutlook.trim());
    out.push({
      id: p.id,
      name: p.fullName,
      team: PRO_TEAM[p.proTeamId] ?? "FA",
      pos,
      injury: p.injuryStatus ?? (p.injured ? "INJURED" : "ACTIVE"),
      adp: p.ownership?.averageDraftPosition ?? null,
      pctOwned: p.ownership?.percentOwned ?? null,
      pctChange: p.ownership?.percentChange ?? null,
      espnRank: p.draftRanksByRankType?.STANDARD?.rank ?? null,
      espnRankRoto: p.draftRanksByRankType?.ROTO?.rank ?? null,
      last: lastE ? toLine(lastE) : null,
      proj: projE ? toLine(projE) : null,
      cur: curE ? toLine(curE) : null,
      age: null,
      bio: null,
      lastNews: typeof p.lastNewsDate === "number" ? p.lastNewsDate : null,
    });
  }
  return out;
}

const BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons";

function filters(season: number, limit: number) {
  const common = {
    filterSlotIds: { value: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
    sortPercOwned: { sortPriority: 1, sortAsc: false },
    limit,
    offset: 0,
  };
  return [
    {
      name: "externalIds",
      filter: {
        players: {
          ...common,
          filterStatsForExternalIds: { value: [season - 1, season] },
          filterStatsForSourceIds: { value: [0, 1] },
          filterStatsForSplitTypeIds: { value: [0] },
        },
      },
    },
    {
      name: "topScoringPeriod",
      filter: {
        players: {
          ...common,
          filterStatsForTopScoringPeriodIds: {
            value: 2,
            additionalValue: [`00${season - 1}`, `10${season}`, `00${season}`],
          },
        },
      },
    },
  ];
}

const ROSTER = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams";

/** Age and bio by ESPN id, read from the 30 team rosters. Cached for a day; missing teams are skipped. */
export async function fetchAges(): Promise<Map<number, { age: number | null; bio: PlayerBio }>> {
  const ages = new Map<number, { age: number | null; bio: PlayerBio }>();
  await Promise.all(
    Array.from({ length: 30 }, (_, i) => i + 1).map(async (teamId) => {
      try {
        const r = await fetch(`${ROSTER}/${teamId}/roster`, {
          headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; TakeoverFantasy/0.1)" },
          next: { revalidate: 60 * 60 * 24 },
        });
        if (!r.ok) return;
        const j = await r.json();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const a of (j?.athletes ?? []) as any[]) {
          const id = Number(a?.id), age = Number(a?.age);
          if (!(id > 0)) continue;
          ages.set(id, {
            age: age > 15 && age < 50 ? age : null,
            bio: {
              height: a?.displayHeight ? String(a.displayHeight).replace(/\s+/g, " ") : null,
              weight: a?.displayWeight ? String(a.displayWeight) : null,
              years: Number.isFinite(Number(a?.experience?.years)) ? Number(a.experience.years) : null,
              jersey: a?.jersey ? String(a.jersey) : null,
              college: a?.college?.shortName ?? a?.college?.name ?? null,
            },
          });
        }
      } catch { /* ages are a refinement; rankings still work without them */ }
    }),
  );
  return ages;
}

export async function fetchEspnPlayers(season: number, limit = 400) {
  const url = `${BASE}/${season}/segments/0/leaguedefaults/1?view=kona_player_info`;
  const errors: string[] = [];
  for (const { name, filter } of filters(season, limit)) {
    try {
      const r = await fetch(url, {
        headers: {
          "X-Fantasy-Filter": JSON.stringify(filter),
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 (compatible; TakeoverFantasy/0.1)",
        },
        // ESPN moves ranks and ADP daily during draft season; refetch at most hourly.
        next: { revalidate: 60 * 60 },
      });
      if (!r.ok) {
        errors.push(`${name}: HTTP ${r.status}`);
        continue;
      }
      const outlooks = new Map<number, string>();
      const players = parsePlayers(await r.json(), season, outlooks);
      const withStats = players.filter((p) => p.proj || p.last).length;
      if (players.length > 0 && withStats >= Math.min(50, players.length / 2)) return { players, source: `espn:${name}`, outlooks };
      errors.push(`${name}: only ${withStats}/${players.length} players had season stats`);
    } catch (e) {
      errors.push(`${name}: ${String(e)}`);
    }
  }
  throw new Error(`ESPN fetch failed: ${errors.join("; ")}`);
}
