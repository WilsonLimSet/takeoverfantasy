/**
 * API Route: /api/inseason/briefing
 * The daily briefing for This week: status changes since the last refresh, waiver picks and
 * injury openings.
 */

import { leagueGet } from '@/lib/inseason/routeContext';
import { generateDailyBriefing } from '@/lib/inseason/optimizer';

export const dynamic = 'force-dynamic';

export const GET = leagueGet('briefing', async (ctx, snapshot) => {
  const lastDiff = await ctx.storage.getLastDiff(ctx.leagueId, ctx.seasonId);
  return { briefing: generateDailyBriefing(snapshot, lastDiff?.statusChanges ?? []), snapshotAge: Date.now() - snapshot.fetchedAt };
});
