import { generateText, Output } from "ai";
import { z } from "zod";
import { withWriter } from "./ai";
import { kvStore } from "./inseason/storage";
import { playbook, postStats } from "./socialStats";
import type { Flop, WaiverTake } from "./waiverTakes";

/**
 * The editor: Claude writes the words on the day's posts, so they read like a person with taste
 * and not a template. The model's numbers and verdicts are fixed (consistency); Claude only
 * chooses the angle and the wording, and picks which take leads the photo post and which gets the
 * headline. Any line quoting a number that isn't in that player's facts falls back to the
 * template, so it can't invent stats. Recent lines are passed in so it doesn't repeat itself.
 */

interface TakeCopy {
  /** Punchline on the slide, a few words. */
  quip: string;
  /** One or two sentences under it on the slide. */
  reason: string;
  /** The tweet-style post on the photo card. */
  post: string;
  /** The caption for that take's single post. */
  caption: string;
}

const LOG = "social:copyLog";

const VOICE = `You write social posts for Takeover Fantasy, a new fantasy basketball (ESPN points leagues) account on Instagram, Threads and X. The goal is followers who trust our waiver calls.

Voice: a sharp friend in your fantasy group chat who actually watches the games. Confident, specific, a little funny, never corny. Plain words. Short sentences. Lead with the most interesting fact. Shams-style for news: the fact first, no hype words.

Rules:
- Every verdict (HOLD, STREAM, STASH, PASS) and every number comes from the facts given. Never change a verdict. Never use a number that isn't in that player's facts.
- No hashtags, no links, at most one emoji per caption (none in quips or posts).
- Don't call anything "breaking" and don't claim sources or insider info.
- Avoid stock phrases: "don't sleep on", "game-changer", "let's go", "buckle up", "here's why", "hot take", "trust the process", "league winner", "must-add". No em dashes.
- Don't reuse any line from the recent posts list, and don't start two posts the same way.
- If "What's been working" is given, lean toward what the best posts did (angle, length, tone) and away from the weakest.
- quip: 2 to 6 words, a punchline that fits the verdict. reason: under 170 characters, the one thing that decides it. post: under 200 characters, reads like a tweet a fan would screenshot. caption: 2 to 4 short lines, ends with a question that gets people to comment.`;

const copySchema = z.object({
  takes: z.array(z.object({ id: z.number(), quip: z.string(), reason: z.string(), post: z.string(), caption: z.string() })),
  photoId: z.number().describe("The take that makes the best photo post (usually last night's biggest story)."),
  headlineId: z.number().describe("A different take for the stat-headline post, ideally a different verdict."),
  carouselCaption: z.string().describe("Caption for the carousel of all takes: a hook line, then one short line per player with the verdict, then a question."),
});
type DayCopy = { takes: Record<number, TakeCopy>; photoId?: number; headlineId?: number; carouselCaption?: string };

function flopFacts(f: Flop): string {
  return [
    `id ${f.id} | ${f.name} (${f.team}, ${f.pos}) | ${f.pctOwned}% rostered | fantasy call ${f.verdict.toUpperCase()}`,
    `last night: ${f.fpts} fantasy points in ${f.min} minutes, ${f.fg} shooting, ${f.tov} turnovers (${f.line})`,
    `usually: about ${f.perGame} fantasy points a game`,
  ].join("\n");
}

function facts(t: WaiverTake): string {
  return [
    `id ${t.id} | ${t.name} (${t.team}, ${t.pos}) | verdict ${t.verdict.toUpperCase()}`,
    `why he's in the news: ${t.hook}`,
    t.night ? `last night: ${t.night.fpts} fantasy points in ${t.night.min} minutes (${t.night.line})` : "",
    `expected: ${Math.round(t.perGame)} fantasy points a game, ${Math.round(t.minutes)} minutes a night${t.lastMin ? ` (${Math.round(t.lastMin)} last season)` : ""}`,
    `${t.pctOwned}% rostered (on waivers in ${100 - t.pctOwned}% of leagues)`,
    `model's reasoning: ${t.reason}`,
  ].filter(Boolean).join("\n");
}

/** Every number a take's copy may quote. */
function allowedNumbers(t: WaiverTake): Set<string> {
  const nums = new Set<string>();
  for (const m of facts(t).matchAll(/\d+(\.\d+)?/g)) nums.add(m[0]);
  for (const n of [t.perGame, t.minutes, t.lastMin ?? 0]) nums.add(String(Math.round(n)));
  return nums;
}

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const WORD_RE = new RegExp(`\\b(${WORDS.join("|")})\\b`, "gi");

/** Every number in the text, digits or spelled out ("seven steals"), is one the facts contain ("one" alone is too common to check). */
const quotesOnly = (text: string, ok: Set<string>) =>
  [...text.matchAll(/\d+(\.\d+)?/g)].every((m) => ok.has(m[0])) &&
  [...text.matchAll(WORD_RE)].every((m) => m[1].toLowerCase() === "one" || ok.has(String(WORDS.indexOf(m[1].toLowerCase()))));

export async function writeCopy(takes: WaiverTake[]): Promise<DayCopy | null> {
  if (!takes.length) return null;
  const kv = kvStore();
  const [log, posts] = await Promise.all([kv.get<string[]>(LOG).catch(() => null), postStats().catch(() => [])]);
  const recent = (log ?? []).slice(-40);
  const working = playbook(posts);
  const res = await withWriter((model) => generateText({
    model,
    system: VOICE,
    prompt: [
      `Today's takes:\n\n${takes.map(facts).join("\n\n")}`,
      working ? `What's been working (our own numbers):\n${working}` : "",
      `Recent posts (don't repeat):\n${recent.map((r) => `- ${r}`).join("\n") || "- none yet"}`,
    ].filter(Boolean).join("\n\n"),
    output: Output.object({ schema: copySchema }),
  })).catch((e) => { console.error("[editor] copy failed", e); return null; });
  if (!res) return null;
  const out = res.output;
  const copy: DayCopy = { takes: {} };
  for (const t of takes) {
    const c = out.takes.find((x) => x.id === t.id);
    if (!c) continue;
    const ok = allowedNumbers(t);
    const clean = (text: string, max: number) => (text && text.length <= max && quotesOnly(text, ok) && !/https?:|#\w/.test(text) ? text.trim() : "");
    copy.takes[t.id] = { quip: clean(c.quip, 40), reason: clean(c.reason, 200), post: clean(c.post, 240), caption: clean(c.caption, 500) };
  }
  const ids = new Set(takes.map((t) => t.id));
  if (ids.has(out.photoId)) copy.photoId = out.photoId;
  if (ids.has(out.headlineId) && out.headlineId !== copy.photoId) copy.headlineId = out.headlineId;
  const allOk = new Set(takes.flatMap((t) => [...allowedNumbers(t)]));
  if (out.carouselCaption.length <= 700 && quotesOnly(out.carouselCaption, allOk) && !/https?:|#\w/.test(out.carouselCaption)) copy.carouselCaption = out.carouselCaption.trim();
  const lines = Object.values(copy.takes).flatMap((c) => [c.quip, c.post]).filter(Boolean);
  if (process.env.VERCEL_ENV === "production") await kv.set(LOG, [...recent, ...lines].slice(-60)).catch(() => {});
  return copy;
}

const SATIRE = `You write satire for Takeover Fantasy, a fantasy basketball account. Last night a player most fantasy managers start had an ugly game. Roast the box score the way the funniest person in a fantasy group chat would.

What's funny: deadpan understatement, mock-official language (a press release, a weather report, a missing-pet flyer, a court ruling, a product recall), absurd but specific comparisons, treating a bad stat line as a historic event. Specific beats generic: build the joke on the actual numbers.
What's off limits: his body, looks, family, personal life, race, money, contract, or any injury. No profanity, no slurs, nothing mean-spirited about the person. Only the basketball.

Then the real fantasy call, in plain words, using the verdict given (for a HOLD: don't panic, he's still a starter for you).

Write three different angles, then choose the funniest. headline: 3 to 8 words for the card, the joke in one line, no hashtags. post: under 200 characters. caption: 2 to 4 short lines, ends with a question that gets comments, at most one emoji.
Every number must come from the facts. No links, no hashtags, no em dashes.`;

const satireSchema = z.object({
  drafts: z.array(z.string()).describe("Three one-line angles you considered."),
  headline: z.string(), post: z.string(), caption: z.string(),
});

/** Claude's roast of last night's flop; null when no attempt passes the checks (then no satire post). */
export async function writeSatire(flop: Flop): Promise<{ headline: string; post: string; caption: string } | null> {
  const kv = kvStore();
  const recent = ((await kv.get<string[]>(LOG).catch(() => null)) ?? []).slice(-30);
  const ok = new Set([...flopFacts(flop).matchAll(/\d+(\.\d+)?/g)].map((m) => m[0]));
  const fine = (text: string, max: number) => !!text && text.length <= max && quotesOnly(text, ok) && !/https?:|#\w/.test(text);
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await withWriter((model) => generateText({
      model, system: SATIRE,
      prompt: `${flopFacts(flop)}\n\nRecent lines (don't repeat):\n${recent.map((r) => `- ${r}`).join("\n") || "- none"}`,
      output: Output.object({ schema: satireSchema }),
    })).catch((e) => { console.error("[editor] satire failed", e); return null; });
    const o = res?.output;
    if (o && fine(o.headline, 60) && fine(o.post, 240) && fine(o.caption, 500)) {
      const out = { headline: o.headline.trim(), post: o.post.trim(), caption: o.caption.trim() };
      if (process.env.VERCEL_ENV === "production") await kv.set(LOG, [...recent, out.headline, out.post].slice(-60)).catch(() => {});
      return out;
    }
  }
  return null;
}
