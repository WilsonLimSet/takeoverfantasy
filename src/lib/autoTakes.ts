import { put } from "@vercel/blob";
import { generateText, Output } from "ai";
import { z } from "zod";
import manualRaw from "../../research/raw-takes.json";
import { compileTakes, currentAuto, mergeItems, normName } from "./compileTakes.mjs";
import { withModel } from "./ai";
import { getPlayers } from "./data";
import { fetchPlayerNews, type NewsItem } from "./playerNews";

/**
 * Automatic takes from ESPN player news. A cron reads news that is new since the last run, asks
 * Claude to turn each item into a take item (injury games, role multipliers, or a note), and
 * republishes takes.json to Blob merged with the manual takes. The live site picks it up within
 * ~5 minutes (see loadTakes), with no build.
 */

/** First regular-season game. Before it, only injuries and transactions move projections. */
const SEASON_START = process.env.NBA_SEASON_START ?? "2026-10-20";
const LOOKBACK_DAYS = 4;
/** Only players a fantasy manager might draft or stream. */
const RELEVANT_PLAYERS = 300;
/** News items per model call, and the most one run handles (the first run has a backlog). */
const ITEMS_PER_CALL = 40;
const MAX_ITEMS_PER_RUN = 240;
const SEEN_KEEP = 3000;

interface RawItem {
  name: string;
  team: string;
  kind: string;
  games?: number;
  mult: Record<string, number>;
  headline: string;
  note: string;
  source: string;
  date: string;
  confidence: "high" | "med" | "low";
  auto?: boolean;
  newsId?: number;
}

interface AutoState { seen: number[]; items: RawItem[]; runAt: string }

const ROLE_STATS = ["pts", "reb", "ast", "stl", "blk", "tov", "fga", "fta", "tpm", "min"] as const;

const decision = z.object({
  newsId: z.number(),
  action: z.enum(["ignore", "note", "update"]).describe(
    "ignore: rest days, routine practice notes, fluff. note: worth showing managers but no projection change. update: changes games or role."),
  kind: z.enum(["injury", "boost", "fade", "new-team"]),
  missedGames: z.number().nullable().describe(
    "For an injury update: regular-season games this injury will cost, including ramp-up. Season-ending: 82. Null when it costs none or the current take already covers it."),
  mult: z.object(Object.fromEntries(ROLE_STATS.map((k) => [k, z.number().nullable()])) as Record<(typeof ROLE_STATS)[number], z.ZodNullable<z.ZodNumber>>)
    .describe("Per-game multipliers vs last season for a real role change (0.85-1.15), null when unchanged."),
  headline: z.string().describe("Under 80 characters, plain and specific."),
  note: z.string().describe("1-2 sentences for fantasy managers: what happened and what it means for value."),
  confidence: z.enum(["high", "med", "low"]),
});

const SYSTEM = `You maintain injury and role takes for an NBA fantasy draft and season tool.
For each ESPN news item, decide whether it changes a player's season projection.
Rules:
- missedGames counts REGULAR-SEASON games only (the season is 82 games, about 3.5 per week). Preseason games don't count. A player out "4 weeks" from early October who returns before the opener misses few or none; one out "4 weeks" starting right before the opener misses about 14. Add a few for ramp-up or re-aggravation risk on soft-tissue injuries (hamstring, calf, groin). Season-ending: 82.
- "Out indefinitely" or "not cleared" with no timeline and no season-ending language: be conservative, about 10-15 games unless the news says the absence is long. Don't guess a long absence from vague news.
- "Day-to-day", rest, or a single missed preseason game: missedGames null (a note at most). A player cleared or returning: missedGames 0.
- If the current take already accounts for the same injury and the timeline hasn't changed, missedGames null.
- Rest days, load management, practice reports and box scores are "ignore", or "note" if a manager would care.
- Multipliers only for real role changes: trades, signings, a starter's long injury opening minutes for a teammate, confirmed rotation changes in the regular season. Keep them between 0.85 and 1.15.
- Never invent facts beyond the news text.
- Write every headline and note in your own words. Never copy a sentence or phrase from the news text; we show your summary instead of the original.`;

const blobBase = () => process.env.TAKES_URL?.replace(/\/[^/]+$/, "") ?? null;

/** A Blob JSON file: null if it doesn't exist yet; throws on any other failure (so a hiccup can't wipe state). */
async function readJson<T>(name: string): Promise<T | null> {
  const base = blobBase();
  if (!base) return null;
  const r = await fetch(`${base}/${name}`, { cache: "no-store" });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Blob read ${name}: ${r.status}`);
  return (await r.json()) as T;
}

const writeJson = (name: string, body: unknown, maxAge = 60) => put(name, JSON.stringify(body), {
  access: "public", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json", cacheControlMaxAge: maxAge,
});

/** Manual takes: the copy published by `npm run takes:publish`, else the one bundled with this build. */
async function manualItems(): Promise<RawItem[]> {
  return (await readJson<RawItem[]>("takes-manual.json")) ?? (manualRaw as RawItem[]);
}

const clampMult = (v: number) => Math.min(1.15, Math.max(0.85, v));

interface IngestResult { checked: number; fresh: number; added: RawItem[]; published: boolean; skipped?: string }

/** `lookbackDays` and `maxItems` widen a backfill; `ignoreTakes` (testing) hides current takes from the model. */
export async function ingestNews(opts: { dryRun?: boolean; lookbackDays?: number; maxItems?: number; ignoreTakes?: boolean } = {}): Promise<IngestResult> {
  const state = (await readJson<AutoState>("auto-takes.json")) ?? { seen: [], items: [], runAt: "" };
  const seen = new Set(state.seen);
  const manual = await manualItems();
  const current = compileTakes(mergeItems(manual, state.items));
  const takeOf = new Map(opts.ignoreTakes ? [] : current.takes.map((t) => [t.key as string, t]));

  const { players } = await getPlayers();
  const since = Date.now() - (opts.lookbackDays ?? LOOKBACK_DAYS) * 864e5;
  const relevant = players
    .filter((p) => p.proj)
    .sort((a, b) => (a.espnRank ?? 999) - (b.espnRank ?? 999))
    .slice(0, RELEVANT_PLAYERS)
    .filter((p) => (p.lastNews ?? 0) > since);

  const fresh: { p: (typeof players)[number]; n: NewsItem }[] = [];
  for (let i = 0; i < relevant.length; i += 10) {
    const batch = relevant.slice(i, i + 10);
    const feeds = await Promise.all(batch.map((p) => fetchPlayerNews(p.id, 3)));
    feeds.forEach((items, j) => {
      for (const n of items) if (!seen.has(n.id) && Date.parse(n.published) > since) fresh.push({ p: batch[j], n });
    });
  }
  fresh.sort((a, b) => b.n.published.localeCompare(a.n.published));
  const todo = fresh.slice(0, opts.maxItems ?? MAX_ITEMS_PER_RUN);
  if (!todo.length) return { checked: relevant.length, fresh: 0, added: [], published: false, skipped: "no new news" };

  const today = new Date().toISOString().slice(0, 10);
  const preseason = today < SEASON_START;
  const header = `Today is ${today}. ${preseason ? `It is the PRESEASON (regular season starts ${SEASON_START}): only injuries and transactions may change games or multipliers; preseason minutes, starts and stats are notes at most.` : "It is the regular season."}`;
  const describe = ({ p, n }: (typeof todo)[number]) => {
    const t = takeOf.get(normName(p.name));
    const cur = t ? `Current take: ${t.headline}${t.games != null ? ` (games ${t.games})` : ""}.` : "No current take.";
    return `newsId ${n.id} | ${p.name} (${p.team}) | ESPN status ${p.injury} | ${n.published.slice(0, 10)}\n${cur}\n${n.headline}\n${n.analysis}`;
  };
  const chunks: (typeof todo)[] = [];
  for (let i = 0; i < todo.length; i += ITEMS_PER_CALL) chunks.push(todo.slice(i, i + ITEMS_PER_CALL));
  // One failed batch shouldn't sink the run: keep the others, and retry the failed items next time.
  const results = await Promise.allSettled(chunks.map((chunk) => withModel((model) => generateText({
    model,
    system: SYSTEM,
    prompt: [header, ...chunk.map(describe)].join("\n\n"),
    output: Output.object({ schema: z.object({ decisions: z.array(decision) }) }),
  }))));
  const answered = new Set<number>();
  results.forEach((r, i) => {
    if (r.status === "fulfilled") for (const x of chunks[i]) answered.add(x.n.id);
    else console.error("[news cron] batch failed:", r.reason);
  });
  if (!answered.size) throw new Error("Every model batch failed");
  const output = { decisions: results.flatMap((r) => (r.status === "fulfilled" ? r.value.output.decisions : [])) };

  const byId = new Map(todo.map((x) => [x.n.id, x]));
  const added: RawItem[] = [];
  const decided = new Set<number>();
  for (const d of output.decisions) {
    const src = byId.get(d.newsId);
    if (!src || decided.has(d.newsId)) continue;
    decided.add(d.newsId);
    if (d.action === "ignore") continue;
    // Notes are for injuries and transactions; box scores and preseason starts are noise on a player card.
    if (d.action === "note" && d.kind !== "injury" && d.kind !== "new-team") continue;
    const roleAllowed = !preseason || d.kind === "new-team";
    const mult = d.action === "update" && roleAllowed
      ? Object.fromEntries(Object.entries(d.mult).filter(([, v]) => v != null && Math.abs(v - 1) >= 0.01).map(([k, v]) => [k, clampMult(v as number)]))
      : {};
    // Games = a healthy-season baseline minus what this injury costs, so the model only has to judge the injury.
    const baseline = Math.min(74, src.p.proj?.gp ?? 70);
    const games = d.action === "update" && d.kind === "injury" && d.missedGames != null
      ? Math.round(Math.max(0, Math.min(baseline, baseline - d.missedGames)))
      : undefined;
    added.push({
      name: src.p.name, team: src.p.team, kind: d.kind, ...(games != null ? { games } : {}), mult,
      headline: d.headline, note: d.note,
      source: `https://www.espn.com/nba/player/_/id/${src.p.id}`,
      date: src.n.published.slice(0, 10), confidence: d.confidence, auto: true, newsId: src.n.id,
    });
  }

  if (opts.dryRun) return { checked: relevant.length, fresh: fresh.length, added, published: false };

  // Our summary of every item, shown in place of ESPN's text (see newsCards).
  const summaries = (await readJson<Record<string, { headline: string; note: string }>>("news-summaries.json")) ?? {};
  for (const d of output.decisions) if (byId.has(d.newsId)) summaries[d.newsId] = { headline: d.headline, note: d.note };
  await writeJson("news-summaries.json", Object.fromEntries(Object.entries(summaries).slice(-SEEN_KEEP)), 300);

  for (const id of answered) seen.add(id);
  // Store only what can still matter (per player: latest games, latest role change, 3 notes).
  const items = [...currentAuto([...state.items, ...added]).values()]
    .flatMap(({ games, mult, notes }) => [games, mult === games ? null : mult, ...notes].filter(Boolean)) as RawItem[];
  const next: AutoState = { seen: [...seen].slice(-SEEN_KEEP), items, runAt: new Date().toISOString() };
  await writeJson("auto-takes.json", next);
  // Re-read the manual takes: a `takes:publish` may have landed while the model was running.
  await writeJson("takes.json", compileTakes(mergeItems(await manualItems(), next.items)));
  return { checked: relevant.length, fresh: fresh.length, added, published: true };
}

const summary = z.object({
  newsId: z.number(),
  headline: z.string().describe("Under 80 characters, plain and specific, in your own words."),
  note: z.string().describe("1-2 sentences for fantasy managers, in your own words."),
});

const SUMMARY_SYSTEM = `You write short summaries of NBA player news for a fantasy basketball app.
For each item write a headline (under 80 characters) and a 1-2 sentence note on what happened and what it means for fantasy managers.
Use your own words: never copy a sentence or phrase from the news text. State only facts in the text; don't speculate.`;

/**
 * Summaries for news shown in the app that the takes run didn't cover (older items, or players
 * outside the top 300 that appear in the Latest feed). Our summary replaces ESPN's text on screen.
 */
export async function summarizeMissing(playerIds: number[], perPlayer = 1): Promise<{ written: number }> {
  if (!blobBase()) return { written: 0 };
  const summaries = (await readJson<Record<string, { headline: string; note: string }>>("news-summaries.json")) ?? {};
  const state = await readJson<AutoState>("auto-takes.json");
  const covered = new Set([...Object.keys(summaries).map(Number), ...(state?.items ?? []).map((i) => i.newsId).filter(Boolean) as number[]]);
  const { players } = await getPlayers();
  const nameOf = new Map(players.map((p) => [p.id, `${p.name} (${p.team})`]));
  const todo: NewsItem[] = [];
  for (let i = 0; i < playerIds.length; i += 10) {
    const feeds = await Promise.all(playerIds.slice(i, i + 10).map((id) => fetchPlayerNews(id, perPlayer)));
    for (const items of feeds) for (const n of items.slice(0, perPlayer)) if (!covered.has(n.id)) todo.push(n);
  }
  const batch = todo.slice(0, MAX_ITEMS_PER_RUN);
  if (!batch.length) return { written: 0 };
  const chunks: NewsItem[][] = [];
  for (let i = 0; i < batch.length; i += ITEMS_PER_CALL) chunks.push(batch.slice(i, i + ITEMS_PER_CALL));
  const results = await Promise.allSettled(chunks.map((chunk) => withModel((model) => generateText({
    model,
    system: SUMMARY_SYSTEM,
    prompt: chunk.map((n) => `newsId ${n.id} | ${nameOf.get(n.playerId) ?? `player ${n.playerId}`} | ${n.published.slice(0, 10)}\n${n.headline}\n${n.analysis}`).join("\n\n"),
    output: Output.object({ schema: z.object({ summaries: z.array(summary) }) }),
  }))));
  const ids = new Set(batch.map((n) => n.id));
  let written = 0;
  for (const r of results) {
    if (r.status !== "fulfilled") { console.error("[news cron] summary batch failed:", r.reason); continue; }
    for (const s of r.value.output.summaries) if (ids.has(s.newsId)) { summaries[s.newsId] = { headline: s.headline, note: s.note }; written++; }
  }
  if (written) await writeJson("news-summaries.json", Object.fromEntries(Object.entries(summaries).slice(-SEEN_KEEP)), 300);
  return { written };
}
