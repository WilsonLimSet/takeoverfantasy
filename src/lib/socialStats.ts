import { kvStore } from "./inseason/storage";

/**
 * Learning from our own posts: Postroom reads each post's numbers on Instagram, Threads and X
 * (views, likes, replies, shares, saves, follows; see postroom's lib/insights.ts) and serves them at
 * /api/v1/stats. From those we score each format, tell the editor what's been working (it writes
 * toward the winners), and post weak formats less often while still testing them now and then.
 */

interface Metrics { views?: number; reach?: number; likes?: number; replies?: number; reposts?: number; shares?: number; saves?: number; follows?: number }
interface StatPost {
  id: string; sourceKey?: string; kind: string; caption: string; scheduledAt: number;
  deliveries: { platform: string; at: number; metrics: Metrics | null }[];
}

const CACHE = "social:stats";
const CACHE_MS = 3 * 60 * 60 * 1000;

/** Our posts from the last 30 days with their numbers (cached a few hours). */
export async function postStats(now = Date.now()): Promise<StatPost[]> {
  const kv = kvStore();
  const cached = await kv.get<{ at: number; posts: StatPost[] }>(CACHE).catch(() => null);
  if (cached && now - cached.at < CACHE_MS) return cached.posts;
  const url = process.env.POSTROOM_URL, key = process.env.POSTROOM_KEY;
  if (!url || !key) return [];
  try {
    const r = await fetch(`${url}/api/v1/stats?days=30`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000), cache: "no-store" });
    if (!r.ok) throw new Error(`stats ${r.status}`);
    const posts = ((await r.json()) as { posts: StatPost[] }).posts;
    await kv.set(CACHE, { at: now, posts }).catch(() => {});
    return posts;
  } catch (e) {
    console.error("[stats]", e instanceof Error ? e.message : e);
    return cached?.posts ?? [];
  }
}

/** The format is the post key's prefix: "takes", "take-photo", "satire", "adds", "breaking-alert"... */
const formatOf = (p: StatPost) => (p.sourceKey ?? p.kind).split(":")[0];

const views = (m: Metrics) => m.views ?? m.reach ?? 0;
/** Engagement weighted by intent: a share or follow is worth far more than a like. */
const score = (m: Metrics) => views(m) + 10 * (m.likes ?? 0) + 20 * (m.replies ?? 0) + 30 * ((m.shares ?? 0) + (m.reposts ?? 0) + (m.saves ?? 0)) + 100 * (m.follows ?? 0);
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

interface Row { post: StatPost; platform: string; format: string; m: Metrics; rel: number }

/** Every measured delivery, with its score relative to that platform's median (so platforms compare). */
function rows(posts: StatPost[]): Row[] {
  const all = posts.flatMap((post) => post.deliveries.filter((d) => d.metrics).map((d) => ({ post, platform: d.platform, format: formatOf(post), m: d.metrics! })));
  const platMedian = new Map<string, number>();
  for (const p of new Set(all.map((r) => r.platform))) platMedian.set(p, Math.max(1, median(all.filter((r) => r.platform === p).map((r) => score(r.m)))));
  return all.map((r) => ({ ...r, rel: score(r.m) / platMedian.get(r.platform)! }));
}

interface FormatScore { format: string; n: number; rel: number; views: number; follows: number }

/** Each format's typical performance (1.0 = an average post on that platform). */
export function formatScores(posts: StatPost[]): FormatScore[] {
  const rs = rows(posts);
  return [...new Set(rs.map((r) => r.format))]
    .map((format) => {
      const mine = rs.filter((r) => r.format === format);
      return { format, n: mine.length, rel: Math.round(median(mine.map((r) => r.rel)) * 100) / 100, views: Math.round(median(mine.map((r) => views(r.m)))), follows: mine.reduce((s, r) => s + (r.m.follows ?? 0), 0) };
    })
    .sort((a, b) => b.rel - a.rel);
}

/** What the editor reads before writing: format scores and our best and worst recent posts. */
export function playbook(posts: StatPost[]): string {
  const rs = rows(posts);
  if (rs.length < 5) return "";
  const scores = formatScores(posts).filter((s) => s.n >= 2);
  const line = (r: Row) => `- [${r.format}, ${r.platform}, ${views(r.m)} views${r.m.follows ? `, ${r.m.follows} follows` : ""}] ${r.post.caption.split("\n").find((l) => l.trim())?.slice(0, 160) ?? ""}`;
  const sorted = [...rs].sort((a, b) => b.rel - a.rel);
  return [
    "Formats, by performance (1.0 = an average post on that platform):",
    ...scores.map((s) => `- ${s.format}: ${s.rel}x over ${s.n} posts, median ${s.views} views${s.follows ? `, ${s.follows} follows` : ""}`),
    "",
    "Our best recent posts (write more like these):",
    ...sorted.slice(0, 4).map(line),
    "",
    "Our weakest recent posts (avoid what these did):",
    ...sorted.slice(-3).map(line),
  ].join("\n");
}

const dayNumber = (date: string) => Math.floor(Date.parse(`${date}T12:00:00Z`) / 864e5);

/**
 * Today's plan. The Instagram carousel: the takes and the waiver-wire slideshow alternate until
 * each has a few measured posts, then the better one runs two days in three. Single posts: a
 * format scoring well under the best (after enough posts to tell) runs every other day instead of
 * daily, so it keeps getting tested without eating the feed.
 */
export function formatPlan(scores: FormatScore[], date: string): { carousel: "takes" | "daily"; runs: (format: string) => boolean } {
  const day = dayNumber(date);
  const by = new Map(scores.map((s) => [s.format, s]));
  const takes = by.get("takes"), daily = by.get("daily");
  const carousel = takes && daily && takes.n >= 4 && daily.n >= 4
    ? (day % 3 === 0 ? (takes.rel >= daily.rel ? "daily" : "takes") : (takes.rel >= daily.rel ? "takes" : "daily"))
    : day % 2 === 0 ? "takes" : "daily";
  const singles = ["take-photo", "take-headline", "satire"].map((f) => by.get(f)).filter((s): s is FormatScore => !!s && s.n >= 6);
  const best = Math.max(0, ...singles.map((s) => s.rel));
  const weak = new Set(singles.filter((s) => s.rel < best * 0.4).map((s) => s.format));
  return { carousel, runs: (format) => !weak.has(format) || day % 2 === 0 };
}
