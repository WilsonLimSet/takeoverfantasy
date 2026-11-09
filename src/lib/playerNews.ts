export interface NewsItem {
  id: number;
  playerId: number;
  /** What happened. */
  headline: string;
  /** Fantasy analysis of it. */
  analysis: string;
  published: string;
  source: string;
}

const NEWS = "https://site.api.espn.com/apis/fantasy/v2/games/fba/news/players";

/** Latest news items for one player from ESPN's fantasy news feed. Cached for 15 minutes unless fresh. */
export async function fetchPlayerNews(playerId: number, limit = 6, fresh = false): Promise<NewsItem[]> {
  try {
    const r = await fetch(`${NEWS}?playerId=${playerId}&limit=${limit}`, {
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; TakeoverFantasy/0.1)" },
      // fresh: the breaking check needs the item that just landed.
      ...(fresh ? { cache: "no-store" as const } : { next: { revalidate: 60 * 15 } }),
    });
    if (!r.ok) return [];
    const j = await r.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((j?.feed ?? []) as any[])
      .filter((x) => x?.headline)
      .map((x) => ({
        id: Number(x.id),
        playerId: Number(x.playerId ?? playerId),
        headline: String(x.headline),
        analysis: String(x.story ?? ""),
        published: String(x.published ?? x.lastModified ?? ""),
        source: String(x.type ?? "ESPN"),
      }));
  } catch {
    return [];
  }
}

/**
 * A news item as we show it. ESPN's news prose is RotoWire's writing, so we never show it: the
 * card carries our own one-line summary (written by the news cron, see autoTakes) when we have one,
 * the date, and a link to read the original on ESPN.
 */
interface NewsCard {
  id: number;
  playerId: number;
  published: string;
  /** Our summary, if the news cron has written one for this item. */
  headline: string | null;
  note: string | null;
  link: string;
}

type Summary = { headline: string; note: string };
let summaries = new Map<number, Summary>();
let summariesAt = 0;
const SUMMARY_RECHECK_MS = 5 * 60 * 1000;

/** Our summaries by ESPN news id: the cron's summary file plus the takes it wrote. */
export async function loadNewsSummaries(): Promise<Map<number, Summary>> {
  const base = process.env.TAKES_URL?.replace(/\/[^/]+$/, "");
  if (!base || Date.now() - summariesAt < SUMMARY_RECHECK_MS) return summaries;
  summariesAt = Date.now();
  try {
    const [file, auto] = await Promise.all(
      ["news-summaries.json", "auto-takes.json"].map((name) => fetch(`${base}/${name}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null))
    );
    const next = new Map<number, Summary>();
    for (const it of (auto?.items ?? []) as Array<{ newsId?: number; headline: string; note: string }>) {
      if (it.newsId) next.set(it.newsId, { headline: it.headline, note: it.note });
    }
    for (const [id, s] of Object.entries((file ?? {}) as Record<string, Summary>)) next.set(Number(id), s);
    summaries = next;
  } catch { /* keep the last good copy */ }
  return summaries;
}

export const espnPlayerUrl = (playerId: number) => `https://www.espn.com/nba/player/_/id/${playerId}`;

export function newsCards(items: NewsItem[], byId: Map<number, Summary>): NewsCard[] {
  return items.map((n) => {
    const s = byId.get(n.id);
    return { id: n.id, playerId: n.playerId, published: n.published, headline: s?.headline ?? null, note: s?.note ?? null, link: espnPlayerUrl(n.playerId) };
  });
}
