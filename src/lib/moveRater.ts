import { getPlayers } from "./data";
import { fppg, streamWindow } from "./social";
import type { Player } from "./types";
import { valueContext, valuePlayer, type PlayerValue } from "./value";

/**
 * "Rate my move": drop one player, add another, get a verdict anyone can share. Free and public, so
 * it only uses league-wide data, valued by src/lib/value.ts (rest of season for the long run, this
 * week's games for streaming), and points people to their own league's waiver wire for the real answer.
 */

export interface MoveSide extends PlayerValue {
  name: string; team: string; pos: string; min: number | null; lastMin: number | null; pctOwned: number;
}
export type Verdict = "make" | "stream" | "close" | "keep";
interface MoveRating { drop: MoveSide; add: MoveSide; verdict: Verdict; headline: string; reasons: string[]; window: string }

const side = (p: Player, v: PlayerValue): MoveSide => ({
  ...v, name: p.name, team: p.team, pos: p.pos.join("/"),
  min: p.cur?.gp ? v.minutes : null, lastMin: p.last?.gp ? Math.round(p.last.min * 10) / 10 : null,
  pctOwned: Math.round(p.pctOwned ?? 0),
});

/** Players worth searching for: anyone with a real role (keeps the picker list small). */
export async function movePlayers(): Promise<{ id: number; name: string; team: string }[]> {
  const { players } = await getPlayers();
  return players
    .filter((p) => p.team !== "FA" && fppg(p) >= 8)
    .sort((a, b) => (b.pctOwned ?? 0) - (a.pctOwned ?? 0))
    .map((p) => ({ id: p.id, name: p.name, team: p.team }));
}

export async function rateMove(dropId: number, addId: number, now = Date.now()): Promise<MoveRating | null> {
  if (dropId === addId) return null;
  const ctx = await valueContext(now);
  const dp = ctx.byId.get(dropId), ap = ctx.byId.get(addId);
  if (!dp || !ap) return null;
  const w = streamWindow(now);
  const drop = side(dp, valuePlayer(dp, ctx, { from: w.from, to: w.end }));
  const add = side(ap, valuePlayer(ap, ctx, { from: w.from, to: w.end }));

  // Long run: rest-of-season value per game left (durability in). This week: games × chance he plays.
  const long = add.ros - drop.ros, week = add.window - drop.window;
  let verdict: Verdict;
  if (long >= 1.5) verdict = "make";
  // Streaming over a better player only makes sense if he'll still be there to re-add.
  else if (long <= -2) verdict = week >= 15 && drop.status === "ACTIVE" && drop.pctOwned < 50 ? "stream" : "keep";
  else verdict = week >= 8 ? "make" : week <= -8 ? "keep" : "close";

  const headline = {
    make: `Make the move: add ${add.name}`,
    stream: `Only for this week: ${add.name}'s games win it, ${drop.name} is better long term`,
    close: `Close call: ${add.name} vs ${drop.name}`,
    keep: drop.status === "OUT" ? `Keep ${drop.name}: stash him on IR if you can` : `Keep ${drop.name}`,
  }[verdict];

  const reasons: string[] = [];
  const [hi, lo] = add.perGame >= drop.perGame ? [add, drop] : [drop, add];
  reasons.push(Math.abs(add.perGame - drop.perGame) < 1
    ? `About even when they play: ${add.perGame} vs ${drop.perGame} fantasy points`
    : `${hi.name} scores more when he plays: ${hi.perGame} vs ${lo.perGame} fantasy points`);
  if (add.games !== drop.games) reasons.push(`${w.label}: ${add.name} has ${add.games} game${add.games === 1 ? "" : "s"} left, ${drop.name} ${drop.games}`);
  for (const s of [add, drop]) {
    if (s.temporary) reasons.push(`${s.name} gets extra minutes while ${s.dependsOn.map((d) => `${d.name} (back ~${d.until})`).join(" and ")} ${s.dependsOn.length > 1 ? "are" : "is"} out; about ${s.temporary.minutesAfter} a game after`);
    else if (s.min != null && s.lastMin != null && Math.abs(s.min - s.lastMin) >= 4) reasons.push(`${s.name} is playing ${s.min > s.lastMin ? "more" : "less"}: about ${s.min} minutes a game, ${s.lastMin} last season`);
    if (s.health === "in-and-out") reasons.push(`${s.name} sits often: about ${Math.round(s.durability * 100)}% of games over the last few seasons, not counting long injuries`);
    if (s.status === "OUT") reasons.push(`${s.name} is out${s.returnDate ? ` until about ${s.returnDate}` : ""}`);
    else if (s.status === "DAY_TO_DAY") reasons.push(`${s.name} is day-to-day`);
  }
  if (Math.abs(add.steady - drop.steady) >= 0.12) {
    const steady = add.steady > drop.steady ? add : drop;
    reasons.push(`${steady.name}'s points come more from rebounds, assists and stocks, so they're steadier week to week`);
  }
  if (Math.abs(long - (add.perGame - drop.perGame)) >= 3) reasons.push(`Over the rest of the season, missed games count: ${add.ros} vs ${drop.ros} expected per game`);
  if (add.pctOwned < 50) reasons.push(`${add.name} is on waivers in ${100 - add.pctOwned}% of leagues`);
  return { drop, add, verdict, headline, reasons: reasons.slice(0, 5), window: w.label };
}
