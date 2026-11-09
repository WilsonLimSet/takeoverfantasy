import { createHmac, timingSafeEqual } from "node:crypto";
import { fppg, POST_LINK, round1, SITE, streamWindow } from "./social";
import { normName } from "./takes";
import type { Player } from "./types";
import { valueContext, valuePlayer } from "./value";

/**
 * The reply bot behind Postroom's reply hook: someone replies to our Threads or X post with their
 * roster or a "X or Y?" question, and we answer from league-wide data, ending with a pointer to
 * their own league. No AI: player names are matched against ESPN's player list.
 */

const sig = () => createHmac("sha256", process.env.CV_SECRET ?? "dev-secret-change-me").update("reply-hook").digest("base64url").slice(0, 24);
/** The hook URL we hand Postroom; the token stops anyone else from using the endpoint. */
export const replyHookUrl = () => `${SITE}/api/reply?t=${sig()}`;
export function validReplyToken(t: string | null): boolean {
  const want = sig();
  return !!t && t.length === want.length && timingSafeEqual(Buffer.from(t), Buffer.from(want));
}

// Last names that are also everyday words or too common to trust on their own.
const AMBIGUOUS = new Set(["green", "white", "brown", "black", "young", "love", "hart", "holiday", "allen", "johnson", "williams", "jones", "smith", "thompson", "porter", "murray", "bridges", "walker", "harris", "mitchell", "jackson", "robinson", "miller", "martin", "wells", "price", "gay", "day", "james", "george", "paul", "ball", "bey", "reed", "king"]);

/** Players named in a message: full names first, then unambiguous last names. */
function findPlayers(text: string, players: Player[]): Player[] {
  const msg = ` ${normName(text).replace(/[^a-z0-9 ]/g, " ")} `.replace(/\s+/g, " ");
  const pool = players.filter((p) => p.team !== "FA" && fppg(p) >= 5);
  const found = new Map<number, Player>();
  for (const p of pool) if (msg.includes(` ${normName(p.name)} `)) found.set(p.id, p);
  const byLast = new Map<string, Player[]>();
  for (const p of pool) {
    const last = normName(p.name).split(" ").pop()!;
    if (last.length >= 4 && !AMBIGUOUS.has(last)) byLast.set(last, [...(byLast.get(last) ?? []), p]);
  }
  for (const [last, raw] of byLast) {
    // Two players share the name: take the far more rostered one, or neither.
    const list = raw.length === 1 ? raw : [...raw].sort((a, b) => (b.pctOwned ?? 0) - (a.pctOwned ?? 0)).filter((p, i, s) => i === 0 && (p.pctOwned ?? 0) >= 3 * (s[1].pctOwned ?? 0) + 5);
    if (list.length !== 1 || found.has(list[0].id) || !msg.includes(` ${last} `)) continue;
    // A full-name match already used this word (e.g. "Jalen Williams" vs another Williams).
    if ([...found.values()].some((f) => normName(f.name).split(" ").includes(last))) continue;
    found.set(list[0].id, list[0]);
  }
  return [...found.values()];
}

const cta = (platform: string) => platform === "x"
  ? "Want the best add on your league's actual waiver wire? Free move, link in our bio."
  : `For your league's actual waiver wire: free move at ${POST_LINK}`;
const pick = <T>(list: T[], seed: string) => list[[...seed].reduce((s, c) => s + c.charCodeAt(0), 0) % list.length];

export async function composeReply(text: string, platform: string, username = ""): Promise<string | null> {
  const ctx = await valueContext();
  const named = findPlayers(text, ctx.players);
  if (!named.length) return null;
  const w = streamWindow();
  const span = w.nextWeek ? "next week" : "left this week";
  const val = new Map(named.map((p) => [p.id, valuePlayer(p, ctx, { from: w.from, to: w.end })]));
  const v = (p: Player) => val.get(p.id) ?? valuePlayer(p, ctx, { from: w.from, to: w.end });
  const last = (p: Player) => p.name.split(" ").slice(1).join(" ") || p.name;

  if (named.length >= 3) {
    const weakest = named.filter((p) => v(p).status !== "OUT").sort((a, b) => v(a).ros - v(b).ros)[0] ?? named[0];
    const pool = ctx.players
      .filter((p) => p.team !== "FA" && (p.pctOwned ?? 100) < 50 && !named.some((n) => n.id === p.id) && fppg(p) >= 12)
      .map((p) => ({ p, v: v(p) }))
      .filter((x) => x.v.status === "ACTIVE");
    const hold = [...pool].sort((a, b) => b.v.ros - a.v.ros)[0];
    const stream = [...pool].sort((a, b) => b.v.window - a.v.window)[0];
    const wv = v(weakest);
    const open = pick(["Your weakest spot", "The spot I'd upgrade", "Weak link"], username + weakest.name);
    const out = named.filter((p) => v(p).status === "OUT" && v(p).returnDate && Date.parse(v(p).returnDate!) - Date.now() > 7 * 864e5).map((p) => `${last(p)} (back ~${v(p).returnDate!.slice(5)})`);
    const ir = out.length ? ` Stash ${out.join(", ")} on IR if you can.` : "";
    if (!hold) return `${open}: ${weakest.name} (${wv.perGame} fpts/g).${ir}\n\n${cta(platform)}`;
    const line = hold.v.ros > wv.ros + 1.5
      ? `Best add on most waiver wires: ${hold.p.name} (${hold.p.team}), ${hold.v.perGame} fpts/g, ${hold.v.games} games ${span}, available in ${100 - Math.round(hold.p.pctOwned ?? 0)}% of leagues.`
      : stream && stream.v.window > wv.window + 8
        ? `Nothing on most wires beats him long term. To stream games, ${stream.p.name} has ${stream.v.games} ${span}.`
        : `Nothing on most wires beats him right now. Hold.`;
    return `${open}: ${weakest.name} (${wv.perGame} fpts/g).${ir} ${line}\n\n${cta(platform)}`;
  }
  if (named.length === 2) {
    const [a, b] = named.map((p) => ({ p, v: v(p) }));
    // This week's games decide a start or a stream; when they're close, the rest of the season does.
    const byWeek = Math.abs(a.v.window - b.v.window) >= 8;
    const [win, lose] = (byWeek ? a.v.window >= b.v.window : a.v.ros >= b.v.ros) ? [a, b] : [b, a];
    const why = byWeek
      ? `${win.v.games} games vs ${lose.v.games} ${span}, ${win.v.perGame} vs ${lose.v.perGame} fpts/g`
      : `${win.v.perGame} vs ${lose.v.perGame} fpts/g${win.v.games === lose.v.games ? ", same number of games" : ""}`;
    const note = lose.v.status === "OUT" ? ` ${last(lose.p)} is out.` : lose.v.status === "DAY_TO_DAY" ? ` ${last(lose.p)} is day-to-day.` : "";
    const temp = win.v.temporary ? ` Note: his minutes are up while ${win.v.temporary.because} is out.` : "";
    // On Threads, link the shareable verdict card (X posts carry no links).
    const rate = platform === "x" ? "" : `\nFull verdict: ${SITE.replace(/^https?:\/\//, "")}/move?drop=${lose.p.id}&add=${win.p.id}&utm_source=threads`;
    return `${win.p.name}: ${why}.${note}${temp}${rate}\n\n${cta(platform)}`;
  }
  const p = named[0], pv = v(p);
  const mins = pv.dependsOn.length
    ? ` Gets ~${Math.round(pv.dependsOn.reduce((m, d) => m + d.minutes, 0))} extra min while ${pv.dependsOn.map((d) => `${d.name.split(" ").slice(-1)[0]} (back ~${d.until.slice(5)})`).join(" and ")} ${pv.dependsOn.length > 1 ? "are" : "is"} out: a hold till then.`
    : p.cur?.gp && p.last?.gp && Math.abs(pv.minutes - p.last.min) >= 3 ? ` Playing about ${pv.minutes} min a game (${round1(p.last.min)} last season).` : "";
  const status = pv.status === "OUT" ? ` Out${pv.returnDate ? ` until ~${pv.returnDate.slice(5)}` : " right now"}.` : pv.status === "DAY_TO_DAY" ? " Day-to-day." : "";
  const sits = pv.health === "in-and-out" ? ` Sits often (~${Math.round(pv.durability * 100)}% of games).` : "";
  const verdict = (p.pctOwned ?? 100) < 50 && pv.ros >= 25 && pv.status === "ACTIVE" ? " Worth an add." : "";
  return `${p.name}: ${pv.perGame} fpts/g, ${pv.games} game${pv.games === 1 ? "" : "s"} ${span}.${mins}${status}${sits}${verdict}\n\n${cta(platform)}`;
}
