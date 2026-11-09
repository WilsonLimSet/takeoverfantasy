/**
 * API Route: /api/inseason/refresh
 *  GET  (Vercel Cron, with CRON_SECRET) -> refresh the owner's env league (Telegram alerts) and every
 *       connected league; the morning run also sends each user's daily moves by email and/or Telegram.
 *  POST (signed-in user or guest league) -> refresh that league now (at most every 5 minutes).
 */

import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { currentAccount } from '@/lib/auth';
import { sendSmartAlerts } from '@/lib/inseason/telegram';
import { generateSmartAlerts, hasActionableAlerts } from '@/lib/inseason/smartAlerts';
import { refreshLeague } from '@/lib/inseason/refreshLeague';
import { getProfile, listProfiles, withAccess, ownerContext, profileContext, saveProfile, type InseasonProfile } from '@/lib/inseason/profile';
import { requireLeague } from '@/lib/inseason/routeContext';
import { buildStreamingPlan } from '@/lib/inseason/streaming';
import { compareMatchupGames } from '@/lib/inseason/matchupGames';
import { dailyEmail, EMAIL_ON, sendEmail } from '@/lib/inseason/email';
import { dailyTelegram, reminderTelegram, rotationTelegram, sendTelegramTo, TELEGRAM_ON } from '@/lib/inseason/telegramUser';
import { placeInLeague, rotationReport, type RotationReport } from '@/lib/rotation';
import { kvStore } from '@/lib/inseason/storage';
import { opponentOutlook } from '@/lib/inseason/opponent';
import { injuryReport, recordInjuryHistory } from '@/lib/inseason/stash';
import type { LeagueSnapshot } from '@/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** The cron's morning run (UTC hour) sends the daily alerts: 11:00 UTC is 7am in New York. */
const EMAIL_HOUR_UTC = 11;
/** The evening run (6pm in New York, before tip-off) reminds about moves due after tonight's games. */
const REMINDER_HOUR_UTC = 23;
const USER_REFRESH_GAP_MS = 5 * 60 * 1000;

async function refreshOwnerLeague() {
  const ctx = await ownerContext('owner');
  if (!ctx) return null;
  const { snapshot, diff, watchlist, transactions } = await refreshLeague(ctx);
  const alerts = generateSmartAlerts(snapshot, diff, watchlist, transactions);
  let alertSent = false;
  try {
    // Old single-chat alerts; only when TELEGRAM_CHAT_ID is set (users get theirs via sendMoves).
    if (process.env.TELEGRAM_CHAT_ID && hasActionableAlerts(alerts)) alertSent = await sendSmartAlerts(alerts, snapshot.week);
  } catch (e) {
    console.error('[Refresh] Telegram failed:', e);
  }
  return { leagueId: snapshot.leagueId, week: snapshot.week, alertSent };
}

/** Send today's moves to the user's channels (email, Telegram), at most once a day. */
async function sendMoves(profile: InseasonProfile, snapshot: LeagueSnapshot, watchIds: number[]): Promise<{ email: boolean; telegram: boolean }> {
  const none = { email: false, telegram: false };
  const date = new Date().toISOString().slice(0, 10);
  if (profile.lastAlert?.date === date) return none;
  const plan = buildStreamingPlan(snapshot, profile.core, watchIds);
  if (!plan) return none;
  // No moves and nothing on the watchlist worth a move: don't message just to say so.
  if (!plan.moves.length && !plan.watchlist.some((w) => w.bestMove)) return none;

  const opts = {
    teamName: profile.teamName ?? 'Your team',
    leagueId: profile.leagueId,
    teamId: profile.teamId,
    plan,
    matchup: compareMatchupGames(snapshot),
    opponent: opponentOutlook(snapshot),
  };
  const [email, telegram] = await Promise.all([
    EMAIL_ON && profile.alerts.email ? sendEmail(profile.email, dailyEmail(opts)) : false,
    TELEGRAM_ON && profile.alerts.telegram && profile.telegram ? sendTelegramTo(profile.telegram.chatId, dailyTelegram(opts)) : false,
  ]);
  if (email || telegram) {
    const key = createHash('sha256').update(JSON.stringify(plan.moves.map((m) => [m.add.id, m.drop.id]))).digest('hex').slice(0, 12);
    await saveProfile({ ...profile, lastAlert: { date, key } });
  }
  return { email, telegram };
}

/** Don't repeat a rotation note about the same player and change within this many days. */
const ROTATION_REPEAT_DAYS = 7;

/** The morning rotation note on Telegram: only changes this user hasn't been sent this week. */
async function sendRotation(profile: InseasonProfile, snapshot: LeagueSnapshot, report: RotationReport): Promise<boolean> {
  if (!profile.telegram || !profile.alerts.telegram) return false;
  const kv = kvStore();
  const key = `rotation:sent:${profile.email}:${profile.leagueId}:${profile.teamId}`;
  const sent = (await kv.get<Record<string, number>>(key).catch(() => null)) ?? {};
  const now = Date.now();
  const fresh = placeInLeague(report, snapshot).filter((e) => now - (sent[`${e.id}:${e.kind}`] ?? 0) > ROTATION_REPEAT_DAYS * 864e5);
  const text = rotationTelegram(fresh, profile.leagueId, profile.teamId);
  if (!text || !(await sendTelegramTo(profile.telegram.chatId, text))) return false;
  for (const e of fresh) sent[`${e.id}:${e.kind}`] = now;
  // Forget old ones so the record stays small.
  for (const [k, t] of Object.entries(sent)) if (now - t > 30 * 864e5) delete sent[k];
  await kv.set(key, sent);
  return true;
}

/** A Telegram nudge when a move is due after tonight's games, at most once a day. */
async function sendReminder(profile: InseasonProfile, snapshot: LeagueSnapshot, watchIds: number[]): Promise<boolean> {
  if (!profile.telegram || !profile.alerts.telegram) return false;
  const date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  if (profile.lastReminder === date) return false;
  const plan = buildStreamingPlan(snapshot, profile.core, watchIds);
  const text = plan && reminderTelegram(plan, date, profile.leagueId, profile.teamId);
  if (!text || !(await sendTelegramTo(profile.telegram.chatId, text))) return false;
  await saveProfile({ ...profile, lastReminder: date });
  return true;
}

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const started = Date.now();
  const sendAlerts = (EMAIL_ON || TELEGRAM_ON) && (new Date().getUTCHours() === EMAIL_HOUR_UTC || new URL(request.url).searchParams.get('alerts') === '1');
  const sendReminders = TELEGRAM_ON && new Date().getUTCHours() === REMINDER_HOUR_UTC;

  let owner = null;
  try {
    owner = await refreshOwnerLeague();
  } catch (e) {
    console.error('[Refresh] owner league failed:', e);
  }
  // Keeps the injured stash's timeline history moving even when nobody opens the page.
  await injuryReport().then(recordInjuryHistory).catch((e) => console.error('[Refresh] injury history failed:', e));

  // Only accounts with a running pass (or no paywall): an expired week pass stops the work and the alerts.
  const profiles = await withAccess(await listProfiles());
  // One rotation report for everyone (cached per night of box scores).
  const rotation = sendAlerts && TELEGRAM_ON ? await rotationReport().catch((e) => { console.error('[Refresh] rotation failed:', e); return null; }) : null;
  let refreshed = 0, failed = 0, emailed = 0, telegrammed = 0;
  // A few at a time keeps ESPN happy and stays well inside the function's time limit.
  for (let i = 0; i < profiles.length; i += 5) {
    await Promise.all(
      profiles.slice(i, i + 5).map(async (profile) => {
        try {
          const ctx = await profileContext(profile);
          const { snapshot, watchlist } = await refreshLeague(ctx);
          refreshed++;
          const fresh = { ...profile, lastRefreshAt: Date.now() };
          await saveProfile(fresh);
          if (sendAlerts) {
            const sent = await sendMoves(fresh, snapshot, watchlist?.playerIds ?? []);
            if (sent.email) emailed++;
            if (sent.telegram) telegrammed++;
            if (rotation && (await sendRotation(fresh, snapshot, rotation).catch(() => false))) telegrammed++;
          }
          if (sendReminders && (await sendReminder(fresh, snapshot, watchlist?.playerIds ?? []))) telegrammed++;
        } catch (e) {
          failed++;
          console.error(`[Refresh] league ${profile.leagueId} failed:`, e instanceof Error ? e.message : e);
        }
      })
    );
  }

  console.log(`[Refresh] ${refreshed} leagues, ${failed} failed, ${emailed} emails, ${telegrammed} telegrams, ${Date.now() - started}ms`);
  return NextResponse.json({ success: true, owner, refreshed, failed, emailed, telegrammed });
}

export async function POST() {
  const account = await currentAccount();
  const { ctx, error } = await requireLeague();
  if (error) return error;
  const profile = ctx.profile && account ? await getProfile(account.email) : null;
  // A guest league (with a pass, before signing in) has no profile: go by its latest snapshot.
  const last = ctx.guest ? (await ctx.storage.getLatestSnapshot(ctx.leagueId, ctx.seasonId))?.fetchedAt : profile?.lastRefreshAt;
  if (last && Date.now() - last < USER_REFRESH_GAP_MS) {
    return NextResponse.json({ success: true, skipped: true });
  }
  try {
    const { snapshot } = await refreshLeague(ctx);
    if (profile) await saveProfile({ ...profile, lastRefreshAt: Date.now() });
    return NextResponse.json({ success: true, fetchedAt: snapshot.fetchedAt });
  } catch (e) {
    console.error('[Refresh] manual refresh failed:', e);
    return NextResponse.json({ success: false, error: 'Could not reach ESPN. Try again in a minute.' }, { status: 502 });
  }
}
