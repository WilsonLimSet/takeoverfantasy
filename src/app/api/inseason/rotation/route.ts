/**
 * API Route: /api/inseason/rotation
 * Rotation changes from the last few box scores (src/lib/rotation.ts), placed in the user's league:
 * which risers are free to add, and which of their own players are losing minutes. Each comes with
 * his games left this week and next, so a pickup can be timed to the schedule.
 */

import { NextResponse } from 'next/server';
import { requireLeague } from '@/lib/inseason/routeContext';
import { freshSnapshot } from '@/lib/inseason/refreshLeague';
import { placeInLeague, rotationReport, type RotationResponse } from '@/lib/rotation';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET() {
  const { ctx, error } = await requireLeague();
  if (error) return error;
  try {
    const [snapshot, report] = await Promise.all([freshSnapshot(ctx), rotationReport()]);
    if (!report) return NextResponse.json({ success: false, error: 'No box scores yet.' }, { status: 404 });
    const entries = placeInLeague(report, snapshot);
    return NextResponse.json({ success: true, night: report.night, entries } satisfies RotationResponse);
  } catch (e) {
    console.error('[rotation]', e);
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : 'Unknown error' }, { status: 500 });
  }
}
