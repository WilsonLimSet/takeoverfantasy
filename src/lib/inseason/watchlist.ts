import type { Watchlist } from '@/types';
import { getLeagueTeams, withLeague } from './espnClient';
import type { LeagueContext } from './profile';

/**
 * The watchlist is the ESPN watchlist plus players added in our app. ESPN is the source of truth
 * for starred players: starring one in the ESPN app adds him here, un-starring drops him (unless
 * he was added here). Removing an ESPN-starred player here hides him until he's un-starred in
 * ESPN, since we can't change the ESPN list.
 */
function mergeWatchlist(saved: Watchlist | null, espnIds: number[]): Watchlist {
  // Lists saved before the split follow ESPN entirely: the old sync only ever added, so players
  // un-starred in ESPN were stuck on them, and they can't be told apart from players added here.
  const appIds = saved?.appIds ?? [];
  const hiddenIds = (saved?.hiddenIds ?? []).filter((id) => espnIds.includes(id));
  const playerIds = [...new Set([...espnIds.filter((id) => !hiddenIds.includes(id)), ...appIds])];
  return { playerIds, lastUpdated: Date.now(), espnIds: [...espnIds], appIds, hiddenIds };
}

const sameList = (a: Watchlist | null, b: Watchlist) =>
  !!a && !!a.appIds && a.playerIds.length === b.playerIds.length && b.playerIds.every((id) => a.playerIds.includes(id))
  && (a.espnIds ?? []).length === (b.espnIds ?? []).length && (b.espnIds ?? []).every((id) => (a.espnIds ?? []).includes(id));

/** Merge this ESPN watchlist into the saved one and save it if anything changed. Undefined (ESPN sent none): unchanged. */
export async function syncWatchlist(ctx: LeagueContext, espnIds: number[] | undefined): Promise<Watchlist | null> {
  const saved = await ctx.storage.getWatchlist(ctx.leagueId, ctx.seasonId);
  if (!espnIds) return saved;
  const next = mergeWatchlist(saved, espnIds);
  if (!sameList(saved, next)) await ctx.storage.storeWatchlist(ctx.leagueId, ctx.seasonId, next);
  return next;
}

/** Read the ESPN watchlist at most once a minute per team (per server instance), so reloads and tab switches reuse it. */
const RECHECK_MS = 60 * 1000;
const checkedAt = new Map<string, number>();

/** Read just the team's ESPN watchlist (a small request) and sync it, so the page shows ESPN changes right away. */
export async function freshWatchlist(ctx: LeagueContext): Promise<Watchlist | null> {
  const key = `${ctx.leagueId}:${ctx.myTeamId}`;
  if (Date.now() - (checkedAt.get(key) ?? 0) < RECHECK_MS) return ctx.storage.getWatchlist(ctx.leagueId, ctx.seasonId);
  checkedAt.set(key, Date.now());
  const teams = await withLeague(ctx.espn, () => getLeagueTeams()).catch((e) => {
    console.warn('[watchlist] ESPN read failed:', e instanceof Error ? e.message : e);
    return null;
  });
  return syncWatchlist(ctx, teams?.find((t) => t.id === ctx.myTeamId)?.watchList);
}
