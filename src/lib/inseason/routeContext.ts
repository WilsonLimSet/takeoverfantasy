import { NextResponse } from 'next/server';
import { leagueContext, type LeagueContext } from './profile';
import { freshSnapshot } from './refreshLeague';
import type { LeagueSnapshot } from '@/types';

/** The caller's league, or the response to send back (sign in, upgrade, or connect a league). */
export async function requireLeague(): Promise<{ ctx: LeagueContext; error?: never } | { ctx?: never; error: NextResponse }> {
  const c = await leagueContext();
  if (c.ok) return { ctx: c.ctx };
  const needs = c.status === 401 ? 'signin' : c.status === 402 ? 'pro' : 'connect';
  return { error: NextResponse.json({ success: false, error: c.error, needs }, { status: c.status }) };
}

/**
 * A GET handler for an In-season tab: the caller's league and its league data, with the same
 * answers everywhere when there's no access, no data yet, or ESPN is down.
 */
export function leagueGet(tag: string, build: (ctx: LeagueContext, snapshot: LeagueSnapshot) => Promise<object> | object) {
  return async () => {
    const { ctx, error } = await requireLeague();
    if (error) return error;
    try {
      const snapshot = await freshSnapshot(ctx);
      if (!snapshot) return NextResponse.json({ success: false, error: 'No league data yet. Hit Refresh on This week to load it.', needs: 'refresh' }, { status: 404 });
      return NextResponse.json({ success: true, ...(await build(ctx, snapshot)) });
    } catch (e) {
      console.error(`[${tag}]`, e);
      return NextResponse.json({ success: false, error: 'Could not reach ESPN. Try again in a minute.' }, { status: 502 });
    }
  };
}
