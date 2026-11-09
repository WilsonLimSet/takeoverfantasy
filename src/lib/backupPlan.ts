import type { LeagueSnapshot } from "@/types";
import { easternDate } from "./social";
import type { Player } from "./types";
import { valueContext, valuePlayer, type PlayerValue, type ValueContext } from "./value";

/**
 * Who to grab if one of your players goes down: the best free agents in your own league, ranked
 * by the points they'd add over the next stretch of games (this matchup week and next), so a guy
 * with four games beats a slightly better one with two. Used for the IR spot when one of your
 * players is ruled out, and as a standing shortlist (/backup on Telegram).
 */

export interface BackupPick { id: number; name: string; team: string; pos: string; games: number; points: number; perGame: number; pctOwned: number; note?: string }

const GROUPS: Record<string, string[]> = { Guards: ["PG", "SG"], Forwards: ["SF", "PF"], Centers: ["C"] };
const DAY = 864e5;

/** Today through the end of next matchup week (or about 10 days when the schedule isn't loaded). */
function backupWindow(snapshot: LeagueSnapshot | null, now = Date.now()): { from: string; to: string } {
  const from = easternDate(now);
  const days = snapshot?.nextMatchupWeek?.days ?? snapshot?.matchupWeek?.days;
  return { from, to: days?.length ? days[days.length - 1].date : easternDate(now + 10 * DAY) };
}

/** Players nobody in this league rosters, healthy enough to play soon. */
function freeAgents(snapshot: LeagueSnapshot, ctx: ValueContext): Player[] {
  const rostered = new Set(snapshot.teams.flatMap((t) => (t.roster ?? []).map((r) => r.player.id)));
  return ctx.players.filter((p) => p.team !== "FA" && !rostered.has(p.id) && (p.pctOwned ?? 0) >= 0.5);
}

const pick = (p: Player, v: PlayerValue): BackupPick => ({
  id: p.id, name: p.name, team: p.team, pos: p.pos.join("/"), games: v.games, points: Math.round(v.window), perGame: v.perGame,
  pctOwned: Math.round(p.pctOwned ?? 0),
  note: v.dependsOn[0] ? `extra minutes while ${v.dependsOn[0].name} is out` : v.status === "DAY_TO_DAY" ? "day-to-day" : undefined,
});

/** The best free agents for the window, overall and by position group. `positions` favors a lineup fit. */
export async function backupPlan(snapshot: LeagueSnapshot, opts: { positions?: string[]; limit?: number; ctx?: ValueContext; now?: number } = {}) {
  const now = opts.now ?? Date.now();
  const ctx = opts.ctx ?? (await valueContext(now));
  const window = backupWindow(snapshot, now);
  const ranked = freeAgents(snapshot, ctx)
    .map((p) => ({ p, v: valuePlayer(p, ctx, window) }))
    .filter((x) => x.v.status !== "OUT" && x.v.games > 0)
    // A small nudge for players who can fill the injured player's spot in the lineup.
    .map((x) => ({ ...x, score: x.v.window * (opts.positions?.some((pos) => x.p.pos.includes(pos as never)) ? 1.05 : 1) }))
    .sort((a, b) => b.score - a.score);
  const limit = opts.limit ?? 3;
  // Each player listed once, under his main position.
  const byGroup = Object.fromEntries(Object.entries(GROUPS).map(([g, pos]) => [g, ranked.filter((x) => pos.includes(x.p.pos[0])).slice(0, 2).map((x) => pick(x.p, x.v))]));
  const hold = [...ranked].sort((a, b) => b.v.ros - a.v.ros)[0];
  return { window, top: ranked.slice(0, limit).map((x) => pick(x.p, x.v)), byGroup, hold: hold ? pick(hold.p, hold.v) : null };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const line = (b: BackupPick) => `${esc(b.name)} (${b.team}): ${b.games} games, ~${b.points} pts${b.note ? `, ${esc(b.note)}` : ""}`;

/** The /backup reply: who to target by position if one of your players goes down. */
export function backupMessage(plan: Awaited<ReturnType<typeof backupPlan>>, teamName: string, addUrl: string): string {
  const parts = [`🛟 <b>Backup plan for ${esc(teamName)}</b>\nIf one of your players goes down, the best free agents in your league (games through ${plan.window.to.slice(5)}):`];
  for (const [g, list] of Object.entries(plan.byGroup)) if (list.length) parts.push(`\n<b>${g}</b>\n${list.map((b) => `• ${line(b)}`).join("\n")}`);
  if (plan.hold) parts.push(`\nBest to keep long term: <b>${esc(plan.hold.name)}</b> (${plan.hold.perGame} pts a game).`);
  parts.push(`\n<a href="${addUrl}">Open ESPN to add</a>`);
  return parts.join("\n");
}
