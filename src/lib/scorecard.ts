import { getPlayers } from "./data";
import { fantasyPoints, PRESETS } from "./engine";
import { kvStore } from "./inseason/storage";
import { easternDate, mostAdded, streamers, weekOf, weekNumber } from "./social";
import type { Player } from "./types";

/**
 * Public receipts: each week we save our top streamers and ESPN's most-added players, with their
 * season totals at that moment. Later, the points they scored since (current totals minus saved
 * totals) show whose picks were better.
 */

const SCORING = PRESETS[0].league.scoring;
const key = (weekStart: string) => `scorecard:${weekStart}`;

interface Saved { id: number; name: string; gp: number; total: number }
interface Picks { week: number; weekStart: string; pickedOn: string; ours: Saved[]; espn: Saved[] }

const snap = (p: { id: number; name: string }, byId: Map<number, Player>): Saved => {
  const cur = byId.get(p.id)?.cur;
  return { id: p.id, name: p.name, gp: cur?.gp ?? 0, total: cur ? fantasyPoints(cur, SCORING) * cur.gp : 0 };
};

/** Save this week's picks, once (the first run of the week wins). */
export async function savePicks(now = Date.now()): Promise<boolean> {
  const today = easternDate(now);
  const { start } = weekOf(today);
  const kv = kvStore();
  if (await kv.get(key(start))) return false;
  const [{ players }, ours, espn] = await Promise.all([getPlayers(), streamers(10, now), mostAdded(10)]);
  const byId = new Map(players.map((p) => [p.id, p]));
  const picks: Picks = { week: weekNumber(today), weekStart: start, pickedOn: today, ours: ours.list.map((p) => snap(p, byId)), espn: espn.map((p) => snap(p, byId)) };
  return kv.claim(key(start), picks);
}

interface SideResult { fppg: number; games: number; players: { id: number; name: string; fppg: number; games: number }[] }
interface Scorecard { week: number; pickedOn: string; complete: boolean; ours: SideResult; espn: SideResult }

function side(list: Saved[], byId: Map<number, Player>): SideResult {
  const players = list.map((s) => {
    const cur = byId.get(s.id)?.cur;
    const games = Math.max(0, (cur?.gp ?? 0) - s.gp);
    const pts = cur ? fantasyPoints(cur, SCORING) * cur.gp - s.total : 0;
    return { id: s.id, name: s.name, games, pts, fppg: games ? pts / games : 0 };
  });
  const games = players.reduce((n, p) => n + p.games, 0);
  const pts = players.reduce((n, p) => n + p.pts, 0);
  return { fppg: games ? pts / games : 0, games, players: players.map(({ pts: _pts, ...p }) => p) };
}

const savedWeeks = async () => (await kvStore().list<Picks>("scorecard:")).sort((a, b) => b.weekStart.localeCompare(a.weekStart));

async function results(list: Picks[], now: number): Promise<Scorecard[]> {
  if (!list.length) return [];
  const { players } = await getPlayers();
  const byId = new Map(players.map((p) => [p.id, p]));
  const thisWeek = weekOf(easternDate(now)).start;
  return list.map((p) => ({ week: p.week, pickedOn: p.pickedOn, complete: p.weekStart < thisWeek, ours: side(p.ours, byId), espn: side(p.espn, byId) }));
}

/** One week's result (the latest finished week by default, else the current one). */
export async function scorecard(week?: number, now = Date.now()): Promise<Scorecard | null> {
  const all = await savedWeeks();
  const thisWeek = weekOf(easternDate(now)).start;
  const picks = week ? all.find((p) => p.week === week) : all.find((p) => p.weekStart < thisWeek) ?? all[0];
  return picks ? (await results([picks], now))[0] : null;
}

/** Every saved week, newest first. */
export const scorecards = async (now = Date.now()) => results(await savedWeeks(), now);
