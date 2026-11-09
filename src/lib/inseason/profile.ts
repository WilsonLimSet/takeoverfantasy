/**
 * In-season profiles
 * Each signed-in user connects one ESPN league: which team is theirs, which players are core
 * (never suggested as drops), and whether they want the daily email. Private leagues also store the
 * user's ESPN cookies, encrypted, so the daily job can read the league while they're away.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { accessFor, currentAccount, currentPass, PAYWALL_ON } from '@/lib/auth';
import { createStorageAdapter, kvStore, type StorageAdapter } from './storage';
import type { ESPNClientConfig } from './espnClient';
import { ownLeagueIds } from '@/lib/espnLeague';
import { clearGuest, guestContext, guestProfile, readGuest } from './guest';

export interface InseasonProfile {
  email: string;
  leagueId: string;
  seasonId: number;
  teamId: number;
  teamName?: string;
  leagueName?: string;
  /** Encrypted "espn_s2|SWID" for private leagues. */
  auth?: string;
  /** Players the user always keeps; the add/drop engine never drops them. */
  core: number[];
  /** Which channels get the daily moves; news (default on) adds the free news alerts on those channels. */
  alerts: { email: boolean; telegram?: boolean; news?: boolean };
  /** The user's Telegram chat with our bot, once linked. */
  telegram?: { chatId: number; username?: string; linkedAt: number };
  /** One-time code for the t.me/<bot>?start=<code> link while they're linking. */
  telegramLink?: { code: string; expires: number };
  createdAt: number;
  updatedAt: number;
  lastRefreshAt?: number;
  /** The last daily email, so the same advice isn't sent twice in a day. */
  lastAlert?: { date: string; key: string };
  /** US date of the last evening reminder (a move due after that night's games). */
  lastReminder?: string;
}

const profileKey = (email: string) => `profile:${email.toLowerCase()}`;

export const getProfile = (email: string) => kvStore().get<InseasonProfile>(profileKey(email));
export const saveProfile = (p: InseasonProfile) => kvStore().set(profileKey(p.email), { ...p, updatedAt: Date.now() });
export const deleteProfile = (email: string) => kvStore().delete(profileKey(email));
export const listProfiles = () => kvStore().list<InseasonProfile>('profile:');

/** Storage scope for a user's league data (keeps the email out of the keys). */
const profileScope = (email: string) => `u_${createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 16)}`;

// ============ Cookie encryption ============

function cookieKey(): Buffer {
  const secret = process.env.ESPN_COOKIE_KEY || process.env.CV_SECRET || (process.env.VERCEL_ENV === 'production' ? '' : 'dev-secret-change-me');
  if (!secret) throw new Error('Set ESPN_COOKIE_KEY or CV_SECRET to store ESPN logins');
  return createHash('sha256').update(`espn-cookies:${secret}`).digest();
}

export function encryptAuth(s2: string, swid: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cookieKey(), iv);
  const body = Buffer.concat([cipher.update(`${s2}|${swid}`, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}

export function decryptAuth(value: string | undefined): { s2: string; swid: string } | null {
  if (!value) return null;
  try {
    const [iv, tag, body] = value.split('.').map((p) => Buffer.from(p, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', cookieKey(), iv);
    decipher.setAuthTag(tag);
    const [s2, swid] = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8').split('|');
    return s2 && swid ? { s2, swid } : null;
  } catch {
    return null;
  }
}

// ============ Request context ============

export interface LeagueContext {
  email: string;
  /** null = the owner's env league (the original single-league setup), or a guest's league. */
  profile: InseasonProfile | null;
  /** A league connected without an account (from the guest cookie): no alerts, no daily runs. */
  guest?: boolean;
  leagueId: number;
  seasonId: number;
  myTeamId: number;
  core: number[];
  espn: ESPNClientConfig;
  storage: StorageAdapter;
}

/** ESPN login for a profile: the user's saved cookies, or the server's for the owner's own leagues. */
function profileAuth(profile: InseasonProfile): { s2: string; swid: string } | null {
  const saved = decryptAuth(profile.auth);
  if (saved) return saved;
  const { ESPN_S2: s2, ESPN_SWID: swid } = process.env;
  return s2 && swid && isOwnerEmail(profile.email) && ownLeagueIds().includes(profile.leagueId) ? { s2, swid } : null;
}

export function profileContext(profile: InseasonProfile): Promise<LeagueContext> {
  const auth = profileAuth(profile);
  return createStorageAdapter(profileScope(profile.email)).then((storage) => ({
    email: profile.email,
    profile,
    leagueId: Number(profile.leagueId),
    seasonId: profile.seasonId,
    myTeamId: profile.teamId,
    core: profile.core,
    espn: { leagueId: profile.leagueId, seasonId: profile.seasonId, espnS2: auth?.s2, swid: auth?.swid },
    storage,
  }));
}

/** The owner's env league, for owners who haven't connected a league through the app. */
export async function ownerContext(email: string): Promise<LeagueContext | null> {
  const leagueId = process.env.ESPN_LEAGUE_ID;
  if (!leagueId) return null;
  const seasonId = parseInt(process.env.ESPN_SEASON || '2026', 10);
  return {
    email,
    profile: null,
    leagueId: Number(leagueId),
    seasonId,
    myTeamId: parseInt(process.env.ESPN_MY_TEAM_ID || '1', 10),
    core: (process.env.ESPN_CORE_PLAYERS ?? '').split(',').map(Number).filter(Boolean),
    espn: { leagueId, seasonId, espnS2: process.env.ESPN_S2, swid: process.env.ESPN_SWID },
    storage: await createStorageAdapter(),
  };
}

export function isOwnerEmail(email: string) {
  return (process.env.OWNER_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).includes(email);
}

/** Whether an account gets in-season work done for it (refreshes, alerts), checked without a browser. */
export async function hasInseasonAccess(email: string): Promise<boolean> {
  return !PAYWALL_ON || isOwnerEmail(email) || !!(await accessFor(email));
}

/** The accounts that have access, checked a few at a time so a big user list stays under Stripe's rate limit. */
export async function withAccess<T extends { email: string }>(profiles: T[]): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < profiles.length; i += 10) {
    const batch = profiles.slice(i, i + 10);
    const ok = await Promise.all(batch.map((p) => hasInseasonAccess(p.email)));
    out.push(...batch.filter((_, j) => ok[j]));
  }
  return out;
}

type ContextResult =
  | { ok: true; ctx: LeagueContext }
  | { ok: false; status: 401 | 402 | 404; error: string };

/**
 * Save the guest league to the account, when the signed-in user confirms it (never silently: a
 * cookie planted by another site mustn't become someone's league). Never overwrites: the profile is
 * only written if the account has none (atomically), and the cookie is cleared either way.
 */
export async function claimGuest(email: string): Promise<InseasonProfile | null> {
  const guest = await readGuest();
  if (!guest) return null;
  const won = await kvStore().claim(profileKey(email), guestProfile(guest, email)).catch((e) => {
    console.error('[profile] guest claim failed', e instanceof Error ? e.message : e);
    return false;
  });
  await clearGuest();
  return getProfile(email).then((p) => p ?? (won ? guestProfile(guest, email) : null));
}

/** The connected league whether or not they've paid, for the free preview: the account's, or the guest cookie's. */
export async function previewContext(): Promise<LeagueContext | null> {
  const account = await currentAccount();
  const profile = account ? await getProfile(account.email) : null;
  if (profile) return profileContext(profile);
  const guest = account ? null : await readGuest();
  return guest ? guestContext(guest) : null;
}

/** Who's asking and which league they've connected. In-season tools are Pro once the paywall is on. */
export async function leagueContext(): Promise<ContextResult> {
  const account = await currentAccount();
  if (!account) {
    // A guest league: the preview without a pass, the tools with one (bought before making an account).
    const guest = await readGuest();
    if (!guest) return { ok: false, status: 401, error: 'Sign in to use the in-season tools.' };
    const paid = !PAYWALL_ON || !!(await currentPass());
    return paid ? { ok: true, ctx: await guestContext(guest) } : { ok: false, status: 402, error: 'The in-season tools are part of Pro.' };
  }
  const owner = isOwnerEmail(account.email);
  const [paid, profile] = await Promise.all([!PAYWALL_ON || owner ? true : currentPass().then(Boolean), getProfile(account.email)]);
  // Connecting is free (it's how a free user sees what they'd gain), so ask for that before payment.
  if (!paid) {
    return profile
      ? { ok: false, status: 402, error: 'The in-season tools are part of Pro.' }
      : { ok: false, status: 404, error: 'Connect your ESPN league first.' };
  }
  if (profile) return { ok: true, ctx: await profileContext(profile) };
  const fallback = owner ? await ownerContext(account.email) : null;
  if (fallback) return { ok: true, ctx: fallback };
  return { ok: false, status: 404, error: 'Connect your ESPN league first.' };
}
