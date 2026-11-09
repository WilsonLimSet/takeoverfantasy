/**
 * API Route: /api/inseason/rotation
 * Rotation changes from the last few box scores (src/lib/rotation.ts), placed in the user's league:
 * which risers are free to add, and which of their own players are losing minutes. Each comes with
 * his games left this week and next, so a pickup can be timed to the schedule.
 */

import { NextResponse } from 'next/server';
import { requireLeague } from '@/lib/inseason/routeContext';
import { freshSnapshot } from '@/lib/inseason/refreshLeague';
import { currentPeriod } from '@/lib/inseason/matchupGames';
import { NBA_TEAMS } from '@/lib/inseason/espnClient';
import { rotationReport, type LeagueRotationEntry, type RotationResponse } from '@/lib/rotation';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const TEAM_ID = new Map(Object.entries(NBA_TEAMS).map(([id, t]) => [t.abbrev, Number(id)]));

export async function GET() {
  const { ctx, error } = await requireLeague();
  if (error) return error;
  try {
    const [snapshot, report] = await Promise.all([freshSnapshot(ctx), rotationReport()]);
    if (!report) return NextResponse.json({ success: false, error: 'No box scores yet.' }, { status: 404 });
    const owner = new Map<number, { mine: boolean; name: string }>();
    for (const t of snapshot?.teams ?? []) for (const r of t.roster ?? []) owner.set(r.player.id, { mine: t.id === snapshot!.myTeamId, name: t.name });
    const waivers = new Set((snapshot?.freeAgentsTopN ?? []).filter((f) => f.onWaivers).map((f) => f.player.id));
    const today = snapshot ? currentPeriod(snapshot) : 0;
    const entries: LeagueRotationEntry[] = report.entries.map((e) => {
      const o = owner.get(e.id);
      const team = TEAM_ID.get(e.team);
      const week = team !== undefined ? snapshot?.matchupWeek?.teamGames[team] : undefined;
      const next = team !== undefined ? snapshot?.nextMatchupWeek?.teamGames[team] : undefined;
      return {
        ...e,
        where: o ? (o.mine ? 'mine' : 'taken') : waivers.has(e.id) ? 'waivers' : 'free',
        owner: o && !o.mine ? o.name : undefined,
        gamesLeft: week ? week.filter((p) => p >= today).length : undefined,
        gamesNext: next?.length,
      };
    });
    return NextResponse.json({ success: true, night: report.night, entries } satisfies RotationResponse);
  } catch (e) {
    console.error('[rotation]', e);
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : 'Unknown error' }, { status: 500 });
  }
}
