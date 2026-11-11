/**
 * Daily move emails, sent through Resend (RESEND_API_KEY; free up to 100 emails a day).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { MatchupGamesComparison } from '@/types';
import type { StreamingPlan } from './streaming';

const SITE = process.env.NEXT_PUBLIC_SITE_URL || 'https://takeoverfantasy.com';
const FROM = process.env.ALERT_FROM_EMAIL || 'Takeover Fantasy <alerts@takeoverfantasy.com>';

export const EMAIL_ON = !!process.env.RESEND_API_KEY;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Smallest watchlist gain worth listing in an alert. */
const WATCH_MIN_GAIN = 10;

/** The best watchlist pickups that aren't already a suggested move. */
export const watchlistHits = (plan: StreamingPlan, max: number) =>
  plan.watchlist
    .filter((w) => w.bestMove && w.bestMove.pointsGain >= WATCH_MIN_GAIN && !plan.moves.some((m) => m.add.id === w.player.id))
    .sort((a, b) => b.bestMove!.pointsGain - a.bestMove!.pointsGain)
    .slice(0, max);

/** ESPN's add/drop page for the user's team. */
export function espnAddUrl(leagueId: string, teamId: number) {
  return `https://fantasy.espn.com/basketball/players/add?leagueId=${leagueId}&teamId=${teamId}`;
}

export function dailyEmail(opts: {
  teamName: string;
  leagueId: string;
  teamId: number;
  plan: StreamingPlan;
  matchup?: MatchupGamesComparison;
}): { subject: string; html: string; text: string } {
  const { plan, matchup } = opts;
  const first = plan.moves[0];
  const subject = first
    ? `${first.swapAfter ? `After ${first.swapAfter.label}'s games: add` : 'Add'} ${first.add.name}, drop ${first.drop.name}: +${Math.round(first.pointsGain)} projected pts this week`
    : `Week ${plan.week}: ${plan.baseline.usableGames} usable games left`;

  const lines: string[] = [];
  const text: string[] = [];
  if (matchup?.opponent) {
    const line = `Usable games left this week: you ${matchup.me.usableGames}, ${matchup.opponent.name} ${matchup.opponent.usableGames}.`;
    lines.push(`<p style="margin:0 0 16px">${esc(line)}</p>`);
    text.push(line);
  }
  if (plan.moves.length) {
    lines.push('<p style="margin:0 0 8px;font-weight:600">Moves for this week</p>');
    for (const m of plan.moves) {
      const head = `${m.swapAfter ? `After ${m.swapAfter.label}'s games: add` : 'Add'} ${m.add.name} (${m.add.nbaTeamAbbrev ?? ''}), drop ${m.drop.name}: +${Math.round(m.pointsGain)} projected pts`;
      const waivers = m.add.onWaivers ? ' He is on waivers, so put in a claim.' : '';
      lines.push(
        `<div style="border:1px solid #e5e5e5;border-radius:8px;padding:12px;margin:0 0 8px">` +
          `<div style="font-weight:600">${esc(head)}</div>` +
          `<div style="color:#666;font-size:14px;margin-top:4px">${esc(`${m.hold} ${m.reason}${waivers}`)}</div>` +
          [m.nextWeekWarning, m.keepWarning].filter(Boolean).map((w) => `<div style="color:#b91c1c;font-size:13px;margin-top:4px">${esc(w!)}</div>`).join('') +
          `</div>`
      );
      text.push(`- ${head}. ${m.hold} ${m.reason}${waivers}${[m.nextWeekWarning, m.keepWarning].filter(Boolean).map((w) => ` ${w}`).join('')}`);
    }
  } else {
    const line = 'No add/drop beats your current roster this week. Sit tight.';
    lines.push(`<p style="margin:0 0 16px">${line}</p>`);
    text.push(line);
  }
  const hits = watchlistHits(plan, 5);
  if (hits.length) {
    lines.push('<p style="margin:16px 0 8px;font-weight:600">From your watchlist</p>');
    for (const w of hits) {
      const line = `${w.player.name}: ${w.player.gamesLeft} games left, +${Math.round(w.bestMove!.pointsGain)} projected pts for ${w.bestMove!.drop.name}`;
      lines.push(`<div style="color:#333;font-size:14px;margin:0 0 4px">${esc(line)}</div>`);
      text.push(`- ${line}`);
    }
  }

  const espn = espnAddUrl(opts.leagueId, opts.teamId);
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#111">` +
    `<p style="color:#666;font-size:13px;margin:0 0 16px">${esc(opts.teamName)} · Week ${plan.week} · ${plan.daysLeft} days left` +
    `${plan.addsLeft !== null ? ` · ${plan.addsLeft} pickups left` : ''}</p>` +
    lines.join('') +
    `<p style="margin:24px 0 0"><a href="${espn}" style="background:#111;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Make moves on ESPN</a></p>` +
    `<p style="color:#999;font-size:12px;margin:24px 0 0">Points are projections. Takeover Fantasy suggests moves; you make them. ` +
    `<a href="${SITE}/inseason/connect" style="color:#999">Change alerts</a></p></div>`;
  text.push('', 'Points are projections, not guarantees.', `Make moves on ESPN: ${espn}`, `Change alerts: ${SITE}/inseason/connect`);
  return { subject, html, text: text.join('\n') };
}

export async function sendEmail(to: string, msg: { subject: string; html: string; text: string; headers?: Record<string, string> }): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to, subject: msg.subject, html: msg.html, text: msg.text, ...(msg.headers ? { headers: msg.headers } : {}) }),
  });
  if (!r.ok) console.error('[email] Resend', r.status, (await r.text()).slice(0, 200));
  return r.ok;
}

/** A signed one-click unsubscribe link for the news emails (no sign-in needed). */
function newsUnsubscribeUrl(email: string): string {
  const secret = process.env.CV_SECRET ?? 'dev-secret-change-me';
  const t = createHmac('sha256', secret).update(`unsub:${email.toLowerCase()}`).digest('base64url').slice(0, 24);
  return `${SITE}/api/news/unsubscribe?e=${encodeURIComponent(email.toLowerCase())}&t=${t}`;
}

export function checkUnsubscribe(email: string, t: string): boolean {
  const want = new URL(newsUnsubscribeUrl(email)).searchParams.get('t') ?? '';
  return want.length === t.length && timingSafeEqual(Buffer.from(want), Buffer.from(t));
}

/** The daily news email: yesterday's posts, image and text, with a one-click unsubscribe. */
export function newsDigestEmail(email: string, posts: { img: string; caption: string }[]) {
  const unsub = newsUnsubscribeUrl(email);
  // Captions end with our call to action and hashtags; the email has its own footer.
  const body = (c: string) => c.replace(/\n*Add\/drops built for your (?:ESPN|fantasy) team:[\s\S]*$/, '').replace(/\n*#\S+(\s#\S+)*\s*$/, '').trim();
  const first = body(posts[0].caption).split('\n')[0].replace(/^[^A-Za-z]+/, '');
  const subject = posts.length > 1 ? `${first.slice(0, 70)} (+${posts.length - 1} more)` : first.slice(0, 90);
  const html =
    `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:#191919">` +
    `<p style="font-size:13px;color:#888;margin:0 0 16px">Takeover Fantasy · today's news</p>` +
    posts.map((p) => `<div style="margin:0 0 28px"><img src="${p.img}" width="560" style="width:100%;max-width:560px;border-radius:12px;border:1px solid #eee" alt=""/>` +
      `<p style="white-space:pre-line;font-size:15px;line-height:1.5;margin:12px 0 0">${esc(body(p.caption))}</p></div>`).join('') +
    `<p style="margin:8px 0 0"><a href="${SITE}/inseason" style="background:#111;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Get moves for your roster</a></p>` +
    `<p style="color:#999;font-size:12px;margin:24px 0 0">You get these because you connected a league at Takeover Fantasy. ` +
    `<a href="${unsub}" style="color:#999">Stop news emails</a></p></div>`;
  const text = [...posts.map((p) => body(p.caption)), `Get moves for your roster: ${SITE}/inseason`, `Stop news emails: ${unsub}`].join('\n\n');
  return { subject, html, text, headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } };
}
