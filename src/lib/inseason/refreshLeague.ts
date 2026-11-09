/**
 * Refresh one league: fetch it from ESPN, store the snapshot, diff and injury history.
 * Shared by the cron (every connected league) and a user's "Refresh now".
 */

import { getLeagueSnapshot, withLeague } from './espnClient';
import { buildLeagueSnapshot, calculateSnapshotDiff } from './dataTransform';
import { saveProfile } from './profile';
import { updateInjuryHistory } from './injuryTracker';
import { injuryReport } from './stash';
import { syncWatchlist } from './watchlist';
import { fetchGameLogs } from './gameLogs';
import { gradePicks, pendingPickIds } from './pickLog';
import { expectedFppg } from './streaming';
import { currentPeriod } from './matchupGames';
import { kvStore } from './storage';
import type { LeagueContext } from './profile';
import type { LeagueSnapshot, LeagueTransaction, SnapshotDiff, Watchlist } from '@/types';

export interface RefreshedLeague {
  snapshot: LeagueSnapshot;
  diff: SnapshotDiff;
  /** The user's ESPN watchlist. */
  watchlist: Watchlist | null;
  transactions: LeagueTransaction[];
}

/** Free agents (best first) whose game logs we load for ranges. */
const LOGGED_FREE_AGENTS = 120;

/** Today's date (US Eastern) if it had NBA games and every one is final; else undefined. */
async function finishedDay(at: number): Promise<string | undefined> {
  const date = new Date(at).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  try {
    const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${date.replace(/-/g, '')}`, { cache: 'no-store', signal: AbortSignal.timeout(8_000) });
    const j = (await r.json()) as { events?: { status?: { type?: { completed?: boolean } } }[] };
    const events = j.events ?? [];
    return events.length && events.every((e) => e.status?.type?.completed) ? date : undefined;
  } catch {
    return undefined;
  }
}

export async function refreshLeague(ctx: LeagueContext): Promise<RefreshedLeague> {
  const [espnData, injuries] = await Promise.all([
    withLeague(ctx.espn, () => getLeagueSnapshot()),
    // Return dates tell a six-week absence from a two-game one; moves still work without them.
    injuryReport().catch((e) => {
      console.warn('[refreshLeague] injury report failed:', e instanceof Error ? e.message : e);
      return null;
    }),
  ]);
  const snapshot = buildLeagueSnapshot({
    settings: espnData.settings,
    teams: espnData.teams,
    matchups: espnData.matchups,
    freeAgents: espnData.freeAgents,
    nbaSchedule: espnData.nbaSchedule,
    myTeamId: ctx.myTeamId,
  });
  if (injuries) snapshot.injuries = Object.fromEntries([...injuries].map(([id, e]) => [id, { returnDate: e.returnDate }]));

  snapshot.dayDone = await finishedDay(snapshot.fetchedAt);

  // Game logs for the players a pick can involve: both rosters in my matchup, the best free
  // agents, and anyone in a logged pick still waiting for a grade. Ranges and grades only.
  const kv = kvStore();
  const pending = await pendingPickIds(kv, ctx.leagueId, ctx.seasonId, ctx.myTeamId).catch(() => [] as number[]);
  const game = snapshot.matchups.find((m) => m.isMyMatchup && m.week === snapshot.week);
  const sides = new Set([ctx.myTeamId, game?.homeTeamId, game?.awayTeamId]);
  const ids = [
    ...snapshot.teams.filter((t) => sides.has(t.id)).flatMap((t) => (t.roster ?? []).map((r) => r.player.id)),
    ...[...snapshot.freeAgentsTopN].sort((a, b) => expectedFppg(b.player) - expectedFppg(a.player)).slice(0, LOGGED_FREE_AGENTS).map((f) => f.player.id),
    ...pending,
  ];
  snapshot.gameLogs = await fetchGameLogs(ctx.espn, ids).catch((e) => {
    console.warn('[refreshLeague] game logs failed:', e instanceof Error ? e.message : e);
    return undefined;
  });
  if (snapshot.gameLogs && pending.length) {
    await gradePicks(kv, ctx.leagueId, ctx.seasonId, ctx.myTeamId, currentPeriod(snapshot), snapshot.gameLogs).catch((e) => console.warn('[refreshLeague] grading failed:', e));
  }

  const { storage, leagueId, seasonId } = ctx;
  const previous = await storage.getLatestSnapshot(leagueId, seasonId);
  const diff = calculateSnapshotDiff(previous, snapshot);
  await storage.storeSnapshot(snapshot);
  await storage.storeLastDiff(leagueId, seasonId, diff);

  const history = updateInjuryHistory(snapshot, await storage.getInjuryHistory(leagueId, seasonId));
  await storage.storeInjuryHistory(leagueId, seasonId, history);

  // The ESPN watchlist syncs on every refresh (src/lib/inseason/watchlist.ts).
  const watchlist = await syncWatchlist(ctx, espnData.teams.find((t) => t.id === ctx.myTeamId)?.watchList);

  const transactions: LeagueTransaction[] = (espnData.recentTransactions || []).map((tx) => ({
    teamId: tx.teamId,
    type: tx.type,
    playerId: tx.playerId,
    playerName: tx.playerName,
    playerSeasonAvg: tx.playerSeasonAvg,
    playerTeamAbbrev: tx.playerTeamAbbrev,
    timestamp: tx.timestamp,
  }));

  return { snapshot, diff, watchlist, transactions };
}

/** Older than this, a page view reloads the league from ESPN (free) instead of waiting for the cron. */
export const VIEW_REFRESH_MS = 30 * 60 * 1000;

/** The stored snapshot, reloaded first when it's missing or older than maxAgeMs. */
export async function freshSnapshot(ctx: LeagueContext, maxAgeMs = VIEW_REFRESH_MS): Promise<LeagueSnapshot | null> {
  const snapshot = await ctx.storage.getLatestSnapshot(ctx.leagueId, ctx.seasonId);
  if (snapshot && Date.now() - snapshot.fetchedAt <= maxAgeMs) return snapshot;
  try {
    const fresh = (await refreshLeague(ctx)).snapshot;
    if (ctx.profile) await saveProfile({ ...ctx.profile, lastRefreshAt: Date.now() });
    return fresh;
  } catch (e) {
    console.error('[refreshLeague] view refresh failed', e);
    return snapshot;
  }
}
