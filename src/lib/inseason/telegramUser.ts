/**
 * Telegram alerts for each user, through one bot (TELEGRAM_BOT_TOKEN).
 * Linking: the user opens t.me/<bot>?start=<code> and presses Start (or types the code). In
 * production a webhook (/api/telegram/webhook) links them the moment the message arrives. Without a
 * webhook (local dev) the My league page polls, and we read pending updates with getUpdates.
 */

import type { MatchupGamesComparison } from '@/types';
import type { StreamingPlan } from './streaming';
import { opponentOutlook, type OpponentOutlook } from './opponent';
import { espnAddUrl, watchlistHits } from './email';
import { kvStore } from './storage';
import { getProfile, hasInseasonAccess, profileContext, saveProfile } from './profile';
import { buildStreamingPlan } from './streaming';
import { compareMatchupGames } from './matchupGames';
import { isRoleDown, isRoleUp, type LeagueRotationEntry } from '../rotation';
import { createHash } from 'node:crypto';

const API = 'https://api.telegram.org';
const SITE = process.env.NEXT_PUBLIC_SITE_URL || 'https://takeoverfantasy.com';

export const TELEGRAM_ON = !!process.env.TELEGRAM_BOT_TOKEN;

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(method: string, body?: object): Promise<any> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  const r = await fetch(`${API}/bot${token}/${method}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description ?? r.status}`);
  return j.result;
}

let botName: string | null = process.env.TELEGRAM_BOT_USERNAME ?? null;
/** The bot's @username, for t.me links. */
export async function botUsername(): Promise<string | null> {
  if (botName || !TELEGRAM_ON) return botName;
  try {
    botName = (await call('getMe')).username ?? null;
  } catch (e) {
    console.error('[telegram] getMe failed', e);
  }
  return botName;
}

const linkKey = (code: string) => `tglink:${code}`;
const OFFSET_KEY = 'tg:offset';
const PAGES = 10;

/** Secret Telegram sends with every webhook call, so only Telegram can post to our webhook. */
export function webhookSecret(): string {
  const base = process.env.TELEGRAM_BOT_TOKEN ?? '';
  return createHash('sha256').update(`tg-webhook:${base}`).digest('hex').slice(0, 48);
}

/**
 * A chat sent a link code (by pressing Start on the deep link, or by typing the code).
 * Links that chat to the account that made the code. Returns the team name, or null for an
 * unknown or expired code.
 */
export async function completeLink(code: string, chat: { id: number; username?: string; first_name?: string }): Promise<string | null> {
  const kv = kvStore();
  const pending = await kv.get<{ email: string; expires: number }>(linkKey(code));
  if (!pending || pending.expires < Date.now()) return null;
  const profile = await getProfile(pending.email);
  if (!profile) return null;
  await saveProfile({
    ...profile,
    telegram: { chatId: chat.id, username: chat.username ?? chat.first_name, linkedAt: Date.now() },
    telegramLink: undefined,
    alerts: { ...profile.alerts, telegram: true },
  });
  await kv.delete(linkKey(code));
  const team = profile.teamName ?? 'your team';
  await sendTelegramTo(
    chat.id,
    `You're connected. Each morning we'll send <b>${esc(team)}</b>'s best add/drops here, only when there's a move worth making.\n\nSend /moves any time for this week's moves, or /stop to pause.`
  );
  // Show them what they signed up for right away (if their pass is running).
  const moves = (await hasInseasonAccess(pending.email)) ? await movesMessage(pending.email) : null;
  if (moves) await sendTelegramTo(chat.id, moves);
  return team;
}

/** This week's moves for an account, as a Telegram message (null if the league isn't loaded yet). */
export async function movesMessage(email: string): Promise<string | null> {
  const profile = await getProfile(email);
  if (!profile) return null;
  const ctx = await profileContext(profile);
  const snapshot = await ctx.storage.getLatestSnapshot(ctx.leagueId, ctx.seasonId);
  if (!snapshot) return null;
  const watch = await ctx.storage.getWatchlist(ctx.leagueId, ctx.seasonId);
  const plan = buildStreamingPlan(snapshot, profile.core, watch?.playerIds ?? []);
  if (!plan) return null;
  return dailyTelegram({
    teamName: profile.teamName ?? 'Your team',
    leagueId: profile.leagueId,
    teamId: profile.teamId,
    plan,
    matchup: compareMatchupGames(snapshot),
    opponent: opponentOutlook(snapshot),
  });
}

/** Pull a link code out of a message: the deep link's "/start CODE", or the code typed on its own. */
export function codeFrom(text: string | undefined): string | null {
  // Codes are 8 letters/digits (see telegram-link); accept them typed in lowercase too.
  return text?.trim().match(/^(?:\/start\s+)?([A-Za-z0-9]{8})$/)?.[1]?.toUpperCase() ?? null;
}

/** Remember a pending link code so its /start can be matched later (30 minutes). */
export async function rememberLinkCode(code: string, email: string) {
  await kvStore().set(linkKey(code), { email, expires: Date.now() + 30 * 60 * 1000 });
}

/**
 * Without a webhook: read every pending update, link any chat that sent a pending code, and mark
 * them all read (offset). Telegram hands out 100 unread updates at a time and keeps them until
 * confirmed, so without confirming, a pile of messages would hide new codes. Does nothing (409)
 * once a webhook is set, since the webhook links people as messages arrive.
 */
export async function drainUpdates(): Promise<void> {
  const kv = kvStore();
  let offset = (await kv.get<number>(OFFSET_KEY)) ?? 0;
  for (let page = 0; page < PAGES; page++) {
    const updates = (await call('getUpdates', { offset, limit: 100, timeout: 0, allowed_updates: ['message'] })) as Array<{
      update_id: number;
      message?: { text?: string; chat?: { id: number; username?: string; first_name?: string } };
    }>;
    if (!updates.length) break;
    for (const u of updates) {
      const code = codeFrom(u.message?.text);
      if (code && u.message?.chat) await completeLink(code, u.message.chat);
    }
    offset = updates[updates.length - 1].update_id + 1;
    await kv.set(OFFSET_KEY, offset);
    if (updates.length < 100) break;
  }
  // Confirm the last batch so Telegram drops it.
  await call('getUpdates', { offset, limit: 1, timeout: 0 }).catch(() => {});
}

export async function sendTelegramTo(chatId: number, html: string): Promise<boolean> {
  try {
    await call('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true });
    return true;
  } catch (e) {
    console.error('[telegram] send failed', e instanceof Error ? e.message : e);
    return false;
  }
}

/**
 * A photo with a caption; chat can be a numeric id or a public channel's @name. Pass the image file
 * (Telegram gives up on slow URLs, and our cards take seconds to draw) or a file_id from an earlier
 * send. Returns the photo's file_id for reuse, or null on failure.
 */
export async function sendTelegramPhoto(chatId: number | string, photo: Blob | string, caption: string): Promise<string | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  // Captions are capped at 1024 characters.
  const text = caption.slice(0, 1024);
  try {
    let r: Response;
    if (typeof photo === 'string') {
      r = await fetch(`${API}/bot${token}/sendPhoto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, photo, caption: text }),
        cache: 'no-store',
      });
    } else {
      const form = new FormData();
      form.set('chat_id', String(chatId));
      form.set('caption', text);
      form.set('photo', photo, 'card.png');
      r = await fetch(`${API}/bot${token}/sendPhoto`, { method: 'POST', body: form, cache: 'no-store' });
    }
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(j.description ?? String(r.status));
    const sizes = j.result?.photo as { file_id: string }[] | undefined;
    return sizes?.at(-1)?.file_id ?? null;
  } catch (e) {
    console.error('[telegram] photo failed', e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Up to 10 photos as one swipeable album, the caption on the first. Pass files, or file_ids from an
 * earlier send. Returns each photo's file_id for reuse, or null on failure.
 */
export async function sendTelegramAlbum(chatId: number | string, photos: (Blob | string)[], caption: string): Promise<string[] | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !photos.length) return null;
  try {
    const form = new FormData();
    form.set('chat_id', String(chatId));
    const media = photos.slice(0, 10).map((p, i) => {
      if (typeof p !== 'string') form.set(`p${i}`, p, `slide${i + 1}.png`);
      return { type: 'photo', media: typeof p === 'string' ? p : `attach://p${i}`, ...(i === 0 ? { caption: caption.slice(0, 1024) } : {}) };
    });
    form.set('media', JSON.stringify(media));
    const r = await fetch(`${API}/bot${token}/sendMediaGroup`, { method: 'POST', body: form, cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(j.description ?? String(r.status));
    return (j.result as { photo?: { file_id: string }[] }[]).map((m) => m.photo?.at(-1)?.file_id ?? '');
  } catch (e) {
    console.error('[telegram] album failed', e instanceof Error ? e.message : e);
    return null;
  }
}

const weekday = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });

/** The evening nudge for moves due after tonight's games (date: today, US Eastern), or null. */
export function reminderTelegram(plan: StreamingPlan, date: string, leagueId: string, teamId: number): string | null {
  const due = plan.moves.filter((m) => m.swapAfter?.date === date);
  if (!due.length) return null;
  const lines = ['<b>Tonight, after the games</b>'];
  for (const m of due) lines.push(`• Once ${esc(m.drop.name)}'s game ends: drop him, <b>add ${esc(m.add.name)}</b> (+${Math.round(m.pointsGain)} projected pts)${m.add.onWaivers ? '. He\'s on waivers, so claim him tonight' : ''}.`);
  lines.push('', `<a href="${esc(espnAddUrl(leagueId, teamId))}">Make moves on ESPN</a>`);
  return lines.join('\n');
}

export function dailyTelegram(opts: {
  teamName: string;
  leagueId: string;
  teamId: number;
  plan: StreamingPlan;
  matchup?: MatchupGamesComparison;
  opponent?: OpponentOutlook | null;
}): string {
  const { plan, matchup, opponent: o } = opts;
  const lines = [`<b>${esc(opts.teamName)}</b> · Week ${plan.week} · ${plan.daysLeft} days left${plan.addsLeft !== null ? ` · ${plan.addsLeft} pickups left` : ''}`];
  const gain = Math.round(plan.moves.reduce((s, m) => s + m.pointsGain, 0));
  if (plan.moves.length) lines.push(`<b>Your edge: +${gain} ${plan.pointsLeague ? 'pts' : 'games'}</b> from ${plan.moves.length} ${plan.moves.length === 1 ? 'move' : 'moves'}${plan.fillsDays?.length ? `, filling ${plan.fillsDays.map(weekday).join(', ')}` : ''}`);
  const p = plan.matchup;
  if (p) {
    const say = (mine: number) => (mine >= p.opponent.projected ? `up ${mine - p.opponent.projected}` : `down ${p.opponent.projected - mine}`);
    lines.push(`Projected: ${p.me.projected} to ${p.opponent.projected} vs ${esc(p.opponentName)} (${say(p.me.projected)})${plan.moves.length ? `. With the moves: ${say(p.me.withMoves)}` : ''}`);
  } else if (matchup?.opponent) {
    lines.push(`Usable games: you ${matchup.me.usableGames}, ${esc(matchup.opponent.name)} ${matchup.opponent.usableGames}`);
  }
  if (o) {
    const adds = (n: number | null) => (n === null ? 'no limit' : String(n));
    lines.push(`Pickups left: you ${adds(plan.addsLeft)}, them ${adds(o.addsLeft)}.${o.moves ? ` If they stream well they add about ${o.pointsGain > 0 && plan.pointsLeague ? `${o.pointsGain} pts` : `${o.gamesWithMoves - o.games} games`}.` : ''}`);
  }
  for (const w of plan.warnings ?? []) lines.push(`⚠️ ${esc(w)}`);
  if (plan.coreCost) lines.push(`Your core list is holding back +${plan.coreCost.gain}: unlocking ${esc(plan.coreCost.players.map((c) => `${c.name} (+${c.pointsGain} with ${c.addName})`).join(' and '))} would add it.`);
  lines.push('');
  if (plan.moves.length) {
    plan.moves.forEach((m, i) => {
      const when = m.swapAfter ? `After ${esc(m.swapAfter.label)}'s games: ` : '';
      lines.push(`${i + 1}. ${when}<b>Add ${esc(m.add.name)}</b>, drop ${esc(m.drop.name)}: <b>+${Math.round(m.pointsGain)} projected pts</b>${m.add.onWaivers ? ' (waivers)' : ''}`);
      lines.push(`   ${esc(`${m.hold} ${m.reason}`)}`);
      for (const w of [m.nextWeekWarning, m.keepWarning]) if (w) lines.push(`   ⚠️ ${esc(w)}`);
    });
  } else {
    lines.push('No add/drop beats your roster this week. Sit tight.');
  }
  const hits = watchlistHits(plan, 3);
  if (hits.length) {
    lines.push('', '<b>Watchlist</b>');
    for (const w of hits) lines.push(`• ${esc(w.player.name)}: ${w.player.gamesLeft} games left, +${Math.round(w.bestMove!.pointsGain)} projected pts for ${esc(w.bestMove!.drop.name)}`);
  }
  lines.push('', `<a href="${esc(espnAddUrl(opts.leagueId, opts.teamId))}">Make moves on ESPN</a> · <a href="${esc(`${SITE}/inseason`)}">Open Takeover</a>`);
  return lines.join('\n');
}

/**
 * The morning rotation note: your players losing minutes, and the best free agents who just got
 * them. Only players not already sent in the last week, so it's news, not a daily repeat.
 */
export function rotationTelegram(entries: LeagueRotationEntry[], leagueId: string, teamId: number): string | null {
  const mine = entries.filter((e) => e.where === 'mine' && isRoleDown(e));
  const pickups = entries
    // Skip a bump whose injured teammate is back within 2 days: gone before the pickup pays off.
    .filter((e) => (e.where === 'free' || e.where === 'waivers') && isRoleUp(e) && (e.kind !== 'opening' || (e.because?.minutes ?? 0) >= 6) && !(e.because && Date.parse(`${e.because.until}T12:00:00Z`) - Date.now() < 2 * 864e5))
    .sort((a, b) => (b.fptsRecent || 0) - (a.fptsRecent || 0))
    .slice(0, 4);
  if (!mine.length && !pickups.length) return null;
  const games = (e: LeagueRotationEntry) => (e.gamesLeft !== undefined ? ` ${e.gamesLeft} games left this week${e.gamesNext !== undefined ? `, ${e.gamesNext} next` : ''}.` : '');
  const lines = ['<b>Rotation watch</b>'];
  if (mine.length) {
    lines.push('', '<b>Your players losing minutes</b>');
    for (const e of mine) lines.push(`• <b>${esc(e.name)}</b> (${esc(e.team)}): ${esc(e.note)}`);
  }
  if (pickups.length) {
    lines.push('', '<b>Just got minutes, free in your league</b>');
    for (const e of pickups) lines.push(`• <b>${esc(e.name)}</b> (${esc(e.team)}${e.where === 'waivers' ? ', waivers' : ''}): ${esc(e.note)}${games(e)}`);
  }
  lines.push('', `<a href="${esc(espnAddUrl(leagueId, teamId))}">Make moves on ESPN</a>`);
  return lines.join('\n');
}
