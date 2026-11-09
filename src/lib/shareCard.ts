/** Parse and sanitize a shared mock-draft result from URL search params. */
interface MockShare {
  grade: string;
  place: number;
  teams: number;
  scoring: string;
  steal: string | null;
  stealBy: number | null;
  picks: string[];
}

const clean = (s: string | null | undefined, max = 40) => (s ?? "").replace(/[^\p{L}\p{N} .'\-]/gu, "").slice(0, max).trim();

export function parseMockShare(q: URLSearchParams | Record<string, string | string[] | undefined>): MockShare {
  const get = (k: string) => {
    if (q instanceof URLSearchParams) return q.get(k);
    const v = q[k];
    return Array.isArray(v) ? v[0] : v ?? null;
  };
  const grade = /^(A\+?|A-|B\+?|B-|C\+?|C|D|F)$/.test(get("g") ?? "") ? get("g")! : "B";
  const teams = Math.max(4, Math.min(20, Number(get("n")) || 10));
  const place = Math.max(1, Math.min(teams, Number(get("p")) || 1));
  const steal = clean(get("b")) || null;
  const stealBy = steal ? Math.max(0, Math.min(200, Number(get("bd")) || 0)) : null;
  const picks = (get("r") ?? "").split("|").map((x) => clean(x)).filter(Boolean).slice(0, 4);
  return { grade, place, teams, scoring: clean(get("s"), 24) || "Points", steal, stealBy, picks };
}

export function mockShareQuery(m: MockShare): string {
  const p = new URLSearchParams({ g: m.grade, p: String(m.place), n: String(m.teams), s: m.scoring });
  if (m.steal) { p.set("b", m.steal); p.set("bd", String(m.stealBy ?? 0)); }
  if (m.picks.length) p.set("r", m.picks.join("|"));
  return p.toString();
}
