/**
 * Injured stash: free agents who are out now but worth a roster spot when they're back. ESPN's
 * injury report gives each injured player an estimated return date and a note; we keep a history
 * of those so the page can say when a timeline moved (pushed back, or moved up).
 */

import { getFreeAgentPool, withLeague } from './espnClient';
import { transformPlayer } from './dataTransform';
import { expectedFppg } from './streaming';
import { kvStore } from './storage';
import type { LeagueContext } from './profile';
import type { LeagueSnapshot } from '@/types';

const INJURIES_URL = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries';
const HISTORY_KEY = 'injuries:history';
/** How often the injury report is re-read into the history. */
const HISTORY_EVERY_MS = 30 * 60 * 1000;
/** Players off the report this long are forgotten. */
const FORGET_AFTER_MS = 60 * 86_400_000;
/** Stash candidates: back within this many days (longer ones are listed but not flagged). */
const STASH_WINDOW_DAYS = 45;

export interface InjuryReportEntry {
  status: string;
  /** ESPN's estimated return, YYYY-MM-DD. */
  returnDate?: string;
  injury?: string;
  note: string;
  detail?: string;
  /** When ESPN last updated the note (ms). */
  updatedAt: number;
}

interface HistoryPoint { at: number; status: string; returnDate?: string; note: string }
interface InjuryHistory { checkedAt: number; players: Record<string, { seenAt: number; points: HistoryPoint[] }> }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawInjury = any;

/** ESPN's league-wide injury report, by ESPN player id (the same ids fantasy uses). */
export async function injuryReport(fresh = false): Promise<Map<number, InjuryReportEntry>> {
  // fresh: the breaking-news check needs this minute's report, not the 15-minute cache.
  const r = await fetch(INJURIES_URL, fresh ? { cache: 'no-store' } : { next: { revalidate: 900 } });
  if (!r.ok) throw new Error(`ESPN injuries: ${r.status}`);
  const j = (await r.json()) as { injuries?: { injuries?: RawInjury[] }[] };
  const out = new Map<number, InjuryReportEntry>();
  for (const team of j.injuries ?? []) {
    for (const i of team.injuries ?? []) {
      const id = Number(String(i.athlete?.links?.[0]?.href ?? '').match(/\/id\/(\d+)/)?.[1]);
      if (!id) continue;
      out.set(id, {
        status: i.status ?? 'Out',
        returnDate: i.details?.returnDate,
        injury: [i.details?.side && i.details.side !== 'Not Specified' ? i.details.side : '', i.details?.type].filter(Boolean).join(' ') || undefined,
        note: i.shortComment ?? '',
        detail: i.longComment,
        updatedAt: Date.parse(i.date) || Date.now(),
      });
    }
  }
  return out;
}

/** Add today's report to the stored history (when a status or return date changed), at most every 30 minutes. */
export async function recordInjuryHistory(report: Map<number, InjuryReportEntry>): Promise<InjuryHistory> {
  const kv = kvStore();
  const history = (await kv.get<InjuryHistory>(HISTORY_KEY).catch(() => null)) ?? { checkedAt: 0, players: {} };
  if (Date.now() - history.checkedAt < HISTORY_EVERY_MS) return history;
  const now = Date.now();
  for (const [id, e] of report) {
    const h = (history.players[id] ??= { seenAt: now, points: [] });
    h.seenAt = now;
    const last = h.points[h.points.length - 1];
    if (!last || last.status !== e.status || last.returnDate !== e.returnDate) {
      h.points.push({ at: now, status: e.status, returnDate: e.returnDate, note: e.note });
      if (h.points.length > 12) h.points.splice(0, h.points.length - 12);
    }
  }
  for (const [id, h] of Object.entries(history.players)) if (now - h.seenAt > FORGET_AFTER_MS) delete history.players[id];
  history.checkedAt = now;
  await kv.set(HISTORY_KEY, history).catch((e) => console.error('[stash] history save failed', e));
  return history;
}

export interface StashPlayer {
  id: number;
  name: string;
  nbaTeamAbbrev?: string;
  positions: string[];
  status: string;
  /** Points per game we expect once he's back. */
  fppg: number;
  percentOwned?: number;
  onWaivers: boolean;
  returnDate?: string;
  daysOut?: number;
  injury?: string;
  note: string;
  detail?: string;
  noteAt: number;
  /** How the return date moved since we first saw it: days later (+) or sooner (-). */
  timelineShift?: { days: number; since: number };
  /** Out longer than the stash window (or for the season). */
  longTerm: boolean;
  /** Better per game than the weakest player on your roster. */
  beatsWeakest: boolean;
}

export interface StashList {
  players: StashPlayer[];
  weakest?: { name: string; fppg: number };
  windowDays: number;
}

const DAY = 86_400_000;
const easternToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const daysUntil = (date: string) => Math.max(0, Math.round((Date.parse(date) - Date.parse(easternToday())) / DAY));

/** Injured free agents in this league, best first, with ESPN's timeline and how it has moved. */
export async function buildStash(ctx: LeagueContext, snapshot: LeagueSnapshot | null): Promise<StashList> {
  const [pool, report] = await Promise.all([
    withLeague(ctx.espn, () => getFreeAgentPool(300, snapshot?.scoringPeriodId)),
    injuryReport(),
  ]);
  const history = await recordInjuryHistory(report);

  const roster = snapshot?.teams.find((t) => t.id === snapshot.myTeamId)?.roster ?? [];
  const weakestEntry = roster
    .filter((e) => e.lineupSlotId !== 13 && e.player.status !== 'OUT' && e.player.status !== 'INJURY_RESERVE')
    .map((e) => ({ name: e.player.name, fppg: Math.round(expectedFppg(e.player) * 10) / 10 }))
    .sort((a, b) => a.fppg - b.fppg)[0];

  const players: StashPlayer[] = [];
  for (const entry of pool.players ?? []) {
    const raw = entry.player;
    if (!raw) continue;
    const p = transformPlayer(raw);
    const r = report.get(p.id);
    const out = p.status === 'OUT' || p.status === 'INJURY_RESERVE' || p.status === 'SUSPENSION' || r?.status === 'Out';
    if (!out) continue;
    const fppg = Math.round(expectedFppg(p) * 10) / 10;
    if (fppg < 15) continue;
    const points = history.players[p.id]?.points ?? [];
    const first = points.find((x) => x.returnDate);
    const shift = first?.returnDate && r?.returnDate && first.returnDate !== r.returnDate
      ? { days: Math.round((Date.parse(r.returnDate) - Date.parse(first.returnDate)) / DAY), since: first.at }
      : undefined;
    const daysOut = r?.returnDate ? daysUntil(r.returnDate) : undefined;
    players.push({
      id: p.id,
      name: p.name,
      nbaTeamAbbrev: p.nbaTeamAbbrev,
      positions: p.positions,
      status: p.status,
      fppg,
      percentOwned: p.ownership?.percentOwned,
      onWaivers: entry.status === 'WAIVERS',
      returnDate: r?.returnDate,
      daysOut,
      injury: r?.injury,
      note: r?.note ?? '',
      detail: r?.detail,
      noteAt: r?.updatedAt ?? 0,
      timelineShift: shift,
      longTerm: daysOut === undefined || daysOut > STASH_WINDOW_DAYS,
      beatsWeakest: !!weakestEntry && fppg > weakestEntry.fppg,
    });
  }
  // Back soonest among the good ones first: within the window by value, then the long-term ones.
  players.sort((a, b) => Number(a.longTerm) - Number(b.longTerm) || b.fppg - a.fppg);
  return { players, weakest: weakestEntry, windowDays: STASH_WINDOW_DAYS };
}
