/**
 * Guest leagues
 * Visitors can connect a league and see their free preview before making an account. The league
 * lives in a signed, httpOnly cookie (never in the KV under an email): which league and team, and for
 * private leagues the ESPN cookies, encrypted with encryptAuth. Signing in turns it into a profile.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { createStorageAdapter, kvStore } from './storage';
import { decryptAuth, type InseasonProfile, type LeagueContext } from './profile';

const GUEST_COOKIE = 'tf_guest';
const GUEST_DAYS = 30;

export interface GuestLeague {
  leagueId: string;
  seasonId: number;
  teamId: number;
  /** Encrypted "espn_s2|SWID" (encryptAuth), only for private leagues. */
  auth?: string;
  /** Shown on the page; trimmed so the cookie stays small. */
  teamName?: string;
  leagueName?: string;
  createdAt: number;
}

const SECRET = process.env.CV_SECRET ?? (process.env.VERCEL_ENV === 'production' ? '' : 'dev-secret-change-me');
const sign = (body: string) => createHmac('sha256', SECRET).update(`guest:${body}`).digest('base64url');

function encode(g: GuestLeague): string {
  const body = Buffer.from(JSON.stringify(g)).toString('base64url');
  return `${body}.${sign(body)}`;
}

/** The cookie's league, or null if it's missing, tampered with, malformed or older than 30 days. */
function decode(value: string | undefined): GuestLeague | null {
  if (!value || !SECRET) return null;
  const [body, sig] = value.split('.');
  if (!body || !sig) return null;
  const good = Buffer.from(sign(body)), got = Buffer.from(sig);
  if (good.length !== got.length || !timingSafeEqual(good, got)) return null;
  try {
    const g = JSON.parse(Buffer.from(body, 'base64url').toString()) as GuestLeague;
    if (!/^\d{1,12}$/.test(String(g.leagueId)) || !Number.isInteger(g.teamId) || g.teamId <= 0 || !Number.isInteger(g.seasonId)) return null;
    if (!Number.isFinite(g.createdAt) || Date.now() - g.createdAt > GUEST_DAYS * 86_400_000) return null;
    return g;
  } catch {
    return null;
  }
}

export async function readGuest(): Promise<GuestLeague | null> {
  return decode((await cookies()).get(GUEST_COOKIE)?.value);
}

/** Only works in route handlers and server functions (Next can't set cookies while rendering). */
export async function writeGuest(g: GuestLeague) {
  if (!SECRET) throw new Error('CV_SECRET is not set');
  const trim = (s?: string) => (s ? s.slice(0, 60) : undefined);
  (await cookies()).set(GUEST_COOKIE, encode({ ...g, teamName: trim(g.teamName), leagueName: trim(g.leagueName) }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: GUEST_DAYS * 86_400,
  });
}

export async function clearGuest() {
  try { (await cookies()).delete(GUEST_COOKIE); } catch { /* rendering: can't change cookies here */ }
}

/** Storage scope for a guest league's data: one per league and team, apart from every profile's scope. */
const guestScope = (g: Pick<GuestLeague, 'leagueId' | 'teamId'>) =>
  `g_${createHash('sha256').update(`${g.leagueId}:${g.teamId}`).digest('hex').slice(0, 16)}`;

export async function guestContext(g: GuestLeague): Promise<LeagueContext> {
  const auth = decryptAuth(g.auth);
  return {
    email: 'guest',
    profile: null,
    guest: true,
    leagueId: Number(g.leagueId),
    seasonId: g.seasonId,
    myTeamId: g.teamId,
    core: [],
    espn: { leagueId: g.leagueId, seasonId: g.seasonId, espnS2: auth?.s2, swid: auth?.swid },
    storage: await createStorageAdapter(guestScope(g)),
  };
}

/** The profile a guest league becomes when its owner signs in. */
export function guestProfile(g: GuestLeague, email: string): InseasonProfile {
  return {
    email,
    leagueId: g.leagueId,
    seasonId: g.seasonId,
    teamId: g.teamId,
    teamName: g.teamName,
    leagueName: g.leagueName,
    auth: g.auth,
    core: [],
    alerts: { email: true, telegram: false },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ============ Rate limit ============

const LOOKUPS_PER_HOUR = 20;

/** The caller's IP, hashed so the KV never holds a raw address. */
function ipKey(req: Request): string {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown';
  return createHash('sha256').update(`ip:${SECRET}:${ip}`).digest('hex').slice(0, 20);
}

/**
 * Each guest lookup hits ESPN, so cap them per IP: 20 an hour. One row per IP (a count and when its
 * hour started), so the table doesn't grow by the hour. Fails open if the KV is down.
 */
export async function guestRateLimited(req: Request): Promise<boolean> {
  const key = `ratelimit:guest:${ipKey(req)}`;
  try {
    const kv = kvStore();
    const now = Date.now();
    const cur = await kv.get<{ n: number; since: number }>(key);
    const fresh = !cur || now - cur.since > 3_600_000;
    const next = fresh ? { n: 1, since: now } : { n: cur.n + 1, since: cur.since };
    if (next.n > LOOKUPS_PER_HOUR) return true;
    await kv.set(key, next);
    return false;
  } catch (e) {
    console.error('[guest] rate limit check failed', e instanceof Error ? e.message : e);
    return false;
  }
}
