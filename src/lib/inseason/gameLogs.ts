/**
 * Game-by-game fantasy points under the league's own scoring (ESPN's kona_playercard view), so a
 * pick can show its range: what he usually scores and how often he lays an egg. One averages-only
 * number hides that a 27-point player can score 7.
 */

import type { ESPNClientConfig } from './espnClient';
import type { GameLog } from '@/types';

const BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons';
/** Most recent scoring periods ESPN returns per player (it spans last season early on). */
const PERIODS = 25;
const CHUNK = 40;
/** Games the range is built from. */
const RANGE_GAMES = 20;
/** Fewer games than this and we don't show a range. */
const MIN_GAMES = 5;

interface Split {
  seasonId?: number;
  statSplitTypeId?: number;
  scoringPeriodId?: number;
  appliedTotal?: number;
  stats?: Record<string, number>;
}

async function fetchChunk(c: ESPNClientConfig, ids: number[]): Promise<Record<number, GameLog>> {
  const url = `${BASE}/${c.seasonId}/segments/0/leagues/${c.leagueId}?view=kona_playercard`;
  const filter = { players: { filterIds: { value: ids }, filterStatsForTopScoringPeriodIds: { value: PERIODS, additionalValue: [`00${c.seasonId}`, `00${c.seasonId - 1}`] } } };
  const r = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'x-fantasy-filter': JSON.stringify(filter),
      ...(c.espnS2 && c.swid ? { Cookie: `espn_s2=${c.espnS2}; SWID=${c.swid}` } : {}),
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`kona_playercard ${r.status}`);
  const j = (await r.json()) as { players?: { id?: number; player?: { id?: number; stats?: Split[] } }[] };
  const out: Record<number, GameLog> = {};
  for (const entry of j.players ?? []) {
    const id = entry.player?.id ?? entry.id;
    if (!id) continue;
    // Single games only (split 5), and only ones he played: a DNP comes back with no stats.
    const games = (entry.player?.stats ?? [])
      .filter((s) => s.statSplitTypeId === 5 && (s.stats?.['42'] ?? 0) > 0 && typeof s.appliedTotal === 'number')
      .sort((a, b) => (b.seasonId ?? 0) - (a.seasonId ?? 0) || (b.scoringPeriodId ?? 0) - (a.scoringPeriodId ?? 0));
    out[id] = {
      cur: games.filter((s) => s.seasonId === Number(c.seasonId)).map((s) => [s.scoringPeriodId!, Math.round(s.appliedTotal! * 10) / 10]),
      prev: games.filter((s) => s.seasonId !== Number(c.seasonId)).map((s) => Math.round(s.appliedTotal! * 10) / 10),
    };
  }
  return out;
}

/** Recent game logs for these players; a failed chunk is skipped (ranges just don't show). */
export async function fetchGameLogs(c: ESPNClientConfig, ids: number[]): Promise<Record<number, GameLog>> {
  const unique = [...new Set(ids)];
  const chunks: number[][] = [];
  for (let i = 0; i < unique.length; i += CHUNK) chunks.push(unique.slice(i, i + CHUNK));
  const parts = await Promise.all(chunks.map((ids) => fetchChunk(c, ids).catch((e) => {
    console.warn('[gameLogs]', e instanceof Error ? e.message : e);
    return {};
  })));
  return Object.assign({}, ...parts);
}

/** What one game from him usually looks like, scaled to the points per game we expect. */
export interface GameRange {
  /** A bad game (1 in 5 are lower) and a good one (1 in 5 are higher). */
  low: number;
  high: number;
  /** Share of games under half his average. */
  bust: number;
  /** Share of games at 1.5x his average or more. */
  boom: number;
  /** Games it's built from. */
  games: number;
}

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * His spread around his own average, from this season's games first and then last season's
 * latest. Each season's games are taken relative to that season's average, so a new role doesn't
 * skew it; the result is scaled to the points per game we expect now.
 */
export function gameRange(log: GameLog | undefined, expected: number): GameRange | undefined {
  if (!log || expected <= 0) return undefined;
  const cur = log.cur.map(([, pts]) => pts).slice(0, RANGE_GAMES);
  const prev = log.prev.slice(0, Math.max(0, RANGE_GAMES - cur.length));
  const rel = (xs: number[]) => {
    const m = xs.length >= 3 ? mean(xs) : 0;
    return m > 0 ? xs.map((x) => x / m) : [];
  };
  const ratios = [...rel(cur), ...rel(prev)];
  if (ratios.length < MIN_GAMES) return undefined;
  return {
    low: Math.round(expected * quantile(ratios, 0.2)),
    high: Math.round(expected * quantile(ratios, 0.8)),
    bust: ratios.filter((r) => r < 0.5).length / ratios.length,
    boom: ratios.filter((r) => r >= 1.5).length / ratios.length,
    games: ratios.length,
  };
}

/** Fantasy points he scored in these scoring periods (a game he sat out scores 0). */
export function pointsIn(log: GameLog | undefined, periods: number[]): number {
  const by = new Map(log?.cur ?? []);
  return periods.reduce((sum, p) => sum + (by.get(p) ?? 0), 0);
}
