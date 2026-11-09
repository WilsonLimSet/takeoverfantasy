/**
 * API Route: /api/inseason/trades
 * GET: trade ideas for your league (paid): league mates' players in a slump to buy low, yours
 * worth more to others than to you to sell high, and offers that win on the value model while
 * looking fair on recent box scores. POST { block: number[] }: save your trade block (the players
 * you're open to trading; offers only send these).
 */

import { NextResponse } from 'next/server';
import { leagueGet, requireLeague } from '@/lib/inseason/routeContext';
import { kvStore } from '@/lib/inseason/storage';
import type { LeagueContext } from '@/lib/inseason/profile';
import { findTrades } from '@/lib/trades';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Per person, league and team, so guests (no email) in the same league never share a block. */
const blockKey = (ctx: LeagueContext) => `trades:block:${(ctx.email || 'guest').toLowerCase()}:${ctx.leagueId}:${ctx.myTeamId}:${ctx.seasonId}`;

export const GET = leagueGet('trades', async (ctx, snapshot) => {
  const block = (await kvStore().get<number[]>(blockKey(ctx)).catch(() => null)) ?? [];
  const found = await findTrades(snapshot, block);
  // Only ids still on your roster (a traded or dropped player falls off the block).
  const mine = new Set(found.roster.map((p) => p.id));
  return { leagueId: ctx.leagueId, seasonId: ctx.seasonId, block: block.filter((id) => mine.has(id)), ...found };
});

export async function POST(req: Request) {
  const { ctx, error } = await requireLeague();
  if (error) return error;
  const body = await req.json().catch(() => null);
  const block = Array.isArray(body?.block) ? body.block.filter((x: unknown) => Number.isInteger(x) && (x as number) > 0).slice(0, 20) : null;
  if (!block) return NextResponse.json({ success: false, error: 'Send { block: [player ids] }' }, { status: 400 });
  await kvStore().set(blockKey(ctx), block);
  return NextResponse.json({ success: true, block });
}
