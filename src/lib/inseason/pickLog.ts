/**
 * Our record: every day we log the pickups we ranked (and the ones we ranked below them), then
 * grade them once their games are played, from the same game logs that build the ranges. The
 * honest question: did our #1 outscore the option we ranked next?
 */

import type { KV } from './storage';
import type { GameLog } from '@/types';
import type { PickMode, StreamingPlan } from './streaming';
import { pointsIn } from './gameLogs';

export interface LoggedPick {
  id: number;
  name: string;
  /** Points we expected over his periods. */
  expected: number;
  /** Scoring periods his games were meant to count. */
  periods: number[];
}

/** One ranked choice: our pick first, then the options we ranked below it. */
export interface PickGroup {
  kind: 'move' | 'bridge';
  picks: LoggedPick[];
}

export interface PickRecord {
  date: string;
  week: number;
  mode: PickMode;
  groups: PickGroup[];
  /** Actual points by player id, once every period is played. */
  actual?: Record<number, number>;
}

const prefix = (leagueId: number, seasonId: number, teamId: number) => `picks:${leagueId}:${seasonId}:${teamId}:`;

const counted = (days: { counts: boolean }[], periods: number[]) => periods.filter((_, i) => days[i]?.counts);

/** The day's ranked choices from a plan, ready to log. */
export function picksFromPlan(plan: StreamingPlan): PickGroup[] {
  const groups: PickGroup[] = [];
  for (const m of plan.moves) {
    if (!m.runnerUp) continue;
    groups.push({
      kind: 'move',
      picks: [
        { id: m.add.id, name: m.add.name, expected: Math.round(m.add.fppg * m.add.usableLeft), periods: m.addPeriods ?? [] },
        { id: m.runnerUp.id, name: m.runnerUp.name, expected: Math.round(m.runnerUp.fppg * m.runnerUp.periods.length), periods: m.runnerUp.periods },
      ],
    });
  }
  if (plan.bridge && plan.bridge.picks.length > 1) {
    const periods = plan.bridge.days.map((d) => d.period);
    groups.push({
      kind: 'bridge',
      picks: plan.bridge.picks.map((p) => {
        const mine = counted(p.days, periods);
        return { id: p.player.id, name: p.player.name, expected: Math.round(p.player.fppg * mine.length), periods: mine };
      }),
    });
  }
  return groups.filter((g) => g.picks.every((p) => p.periods.length));
}

/** Log today's choices once: the first look of the day is what we stand by. */
export async function logPicks(kv: KV, leagueId: number, seasonId: number, teamId: number, date: string, plan: StreamingPlan): Promise<void> {
  const groups = picksFromPlan(plan);
  if (!groups.length) return;
  await kv.claim<PickRecord>(`${prefix(leagueId, seasonId, teamId)}${date}`, { date, week: plan.week, mode: plan.mode.kind, groups });
}

/** Ungraded records' player ids, so the refresh can fetch their game logs. */
export async function pendingPickIds(kv: KV, leagueId: number, seasonId: number, teamId: number): Promise<number[]> {
  const recs = await kv.list<PickRecord>(prefix(leagueId, seasonId, teamId)).catch(() => []);
  return recs.filter((r) => !r.actual).flatMap((r) => r.groups.flatMap((g) => g.picks.map((p) => p.id)));
}

/** Grade every record whose games are all played (before the current scoring period). */
export async function gradePicks(kv: KV, leagueId: number, seasonId: number, teamId: number, today: number, logs: Record<number, GameLog>): Promise<number> {
  const recs = await kv.list<PickRecord>(prefix(leagueId, seasonId, teamId));
  let graded = 0;
  for (const r of recs) {
    if (r.actual) continue;
    const picks = r.groups.flatMap((g) => g.picks);
    if (picks.some((p) => Math.max(...p.periods) >= today)) continue;
    // A player with no log at all (ESPN didn't return him) can't be graded yet.
    if (picks.some((p) => !logs[p.id])) continue;
    r.actual = Object.fromEntries(picks.map((p) => [p.id, Math.round(pointsIn(logs[p.id], p.periods))]));
    await kv.set(`${prefix(leagueId, seasonId, teamId)}${r.date}`, r);
    graded++;
  }
  return graded;
}

export interface PickTrackRecord {
  /** Ranked choices graded. */
  graded: number;
  /** Times our #1 scored at least as much as the option we ranked next. */
  beatNext: number;
  /** Our #1's average place among the options we ranked (1 = best), when there were 3 or more. */
  avgPlace?: number;
  /** Our #1s: points scored against points expected, in total. */
  scored: number;
  expected: number;
  recent: { date: string; kind: PickGroup['kind']; pick: string; got: number; next: string; nextGot: number }[];
}

export function summarize(recs: PickRecord[]): PickTrackRecord {
  const out: PickTrackRecord = { graded: 0, beatNext: 0, scored: 0, expected: 0, recent: [] };
  const places: number[] = [];
  for (const r of [...recs].filter((r) => r.actual).sort((a, b) => b.date.localeCompare(a.date))) {
    for (const g of r.groups) {
      const [top, next] = g.picks;
      const got = r.actual![top.id] ?? 0;
      const nextGot = r.actual![next.id] ?? 0;
      out.graded++;
      if (got >= nextGot) out.beatNext++;
      out.scored += got;
      out.expected += top.expected;
      if (g.picks.length >= 3) places.push(1 + g.picks.slice(1).filter((p) => (r.actual![p.id] ?? 0) > got).length);
      if (out.recent.length < 5) out.recent.push({ date: r.date, kind: g.kind, pick: top.name, got, next: next.name, nextGot });
    }
  }
  if (places.length) out.avgPlace = Math.round((places.reduce((a, b) => a + b, 0) / places.length) * 10) / 10;
  return out;
}

export async function trackRecord(kv: KV, leagueId: number, seasonId: number, teamId: number): Promise<PickTrackRecord> {
  return summarize(await kv.list<PickRecord>(prefix(leagueId, seasonId, teamId)).catch(() => []));
}

/** Every league's record together, for the public number. */
export async function overallRecord(kv: KV): Promise<PickTrackRecord> {
  return summarize(await kv.list<PickRecord>('picks:').catch(() => []));
}
