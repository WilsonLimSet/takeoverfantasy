import { Cat, League, Valued, edgeTags, fantasyPoints } from "./engine";
import { DraftSequence, fillLineup, teamForPick } from "./draft";

interface Insight { tone: "good" | "bad" | "info"; text: string }

const espnRank = (v: Valued, league: League) =>
  (league.format === "cats" ? v.p.espnRankRoto ?? v.p.espnRank : v.p.espnRank ?? v.p.espnRankRoto) ?? null;
const round = (pick: number, teams: number) => Math.max(1, Math.ceil(pick / teams));
const CAT_LABEL: Record<Cat, string> = {
  pts: "points", reb: "rebounds", ast: "assists", stl: "steals", blk: "blocks", tpm: "threes", tov: "turnovers",
  "fg%": "FG%", "ft%": "FT%", dd: "double-doubles", oreb: "offensive boards",
};

/** Plain-language reasons behind a player's rank in this league. */
export function playerInsights(v: Valued, league: League): Insight[] {
  const out: Insight[] = [];
  const { p } = v;
  const ours = v.proj.line;
  const er = espnRank(v, league);

  if (er != null) {
    const d = er - v.rank;
    if (d >= 5) out.push({ tone: "good", text: `We rank him #${v.rank}, ${d} spots ahead of ESPN (#${er}).` });
    else if (d <= -5) out.push({ tone: "bad", text: `We rank him #${v.rank}, ${-d} spots behind ESPN (#${er}).` });
    else out.push({ tone: "info", text: `We agree with ESPN's rank (#${er} there, #${v.rank} here).` });
  }

  if (p.adp != null) {
    const gap = p.adp - v.rank;
    const r = round(p.adp, league.teams);
    if (gap >= 8) out.push({ tone: "good", text: `Market discount: he usually goes around pick ${p.adp.toFixed(0)} (round ${r}), later than his value here.` });
    else if (gap <= -8) out.push({ tone: "bad", text: `Market premium: drafters take him around pick ${p.adp.toFixed(0)} (round ${r}), earlier than we would.` });
  }

  if (league.format === "points" && p.proj) {
    const espnFp = fantasyPoints(p.proj, league.scoring);
    const diff = v.fppg - espnFp;
    if (Math.abs(diff) >= 1.5) {
      out.push({
        tone: diff > 0 ? "good" : "bad",
        text: `Per game we project ${v.fppg.toFixed(1)} fantasy points in your scoring, ${Math.abs(diff).toFixed(1)} ${diff > 0 ? "more" : "fewer"} than ESPN's line implies.`,
      });
    }
  }

  if (p.proj && Math.abs(v.proj.games - p.proj.gp) >= 5) {
    const fewer = v.proj.games < p.proj.gp;
    out.push({
      tone: fewer ? "bad" : "good",
      text: `We expect ${v.proj.games.toFixed(0)} games, ESPN projects ${p.proj.gp.toFixed(0)}${p.last ? ` (he played ${p.last.gp.toFixed(0)} last season)` : ""}.`,
    });
  }

  if (p.last && p.last.gp >= 20) {
    const dPts = ours.pts - p.last.pts, dMin = ours.min - p.last.min;
    if (dPts >= 2) out.push({ tone: "good", text: `Scoring projected up ${dPts.toFixed(1)} a game from last season (${p.last.pts.toFixed(1)} → ${ours.pts.toFixed(1)}).` });
    else if (dPts <= -2) out.push({ tone: "bad", text: `Scoring projected down ${(-dPts).toFixed(1)} a game from last season (${p.last.pts.toFixed(1)} → ${ours.pts.toFixed(1)}).` });
    if (p.last.min && Math.abs(dMin) >= 2.5) out.push({ tone: dMin > 0 ? "good" : "bad", text: `Minutes ${dMin > 0 ? "up" : "down"} to about ${ours.min.toFixed(0)} a night (from ${p.last.min.toFixed(0)}).` });
  } else if (!p.last) {
    out.push({ tone: "info", text: "No NBA track record last season, so this leans on the preseason projection and reports." });
  }

  if (league.format === "cats") {
    const cats = league.cats.filter((c) => !league.punts.includes(c));
    const sorted = cats.map((c) => ({ c, z: v.z[c] ?? 0 })).sort((a, b) => b.z - a.z);
    const strong = sorted.filter((x) => x.z >= 1).slice(0, 3);
    const weak = sorted.filter((x) => x.z <= -1).slice(-2);
    if (strong.length) out.push({ tone: "good", text: `Wins you ${strong.map((x) => CAT_LABEL[x.c]).join(", ")}.` });
    if (weak.length) out.push({ tone: "bad", text: `Hurts in ${weak.map((x) => CAT_LABEL[x.c]).join(" and ")}.` });
  } else {
    const tags = edgeTags(ours);
    if (tags.length) out.push({ tone: "info", text: `Profile: ${tags.join(", ").toLowerCase()}.` });
  }

  if (p.age != null && p.age > 32) out.push({ tone: "bad", text: `Age ${p.age}: we trim his games for the extra rest and injury risk.` });
  if (p.last && p.last.gp < 15 && p.proj) out.push({ tone: "info", text: `Only ${p.last.gp.toFixed(0)} games last season, so the per-game line leans on ESPN's projection.` });
  if (p.team === "FA" && !p.proj) out.push({ tone: "bad", text: "Unsigned and without an ESPN projection, so his games are heavily discounted." });
  if (p.injury && p.injury !== "ACTIVE") out.push({ tone: "bad", text: `Currently listed ${p.injury.replace(/_/g, " ").toLowerCase()}.` });
  return out;
}

/* ---------------- Mock draft review ---------------- */

interface PickReview { k: number; v: Valued; delta: number; label: "Steal" | "Value" | "Fair" | "Reach" }
interface TeamReview {
  t: number; score: number; place: number; grade: string; fppg: number;
  /** Average projected games of the starters. */
  games: number;
  best: Valued | null;
}
interface DraftReview {
  teams: TeamReview[];
  mine: TeamReview;
  myPicks: PickReview[];
  bestPick: PickReview | null;
  worstPick: PickReview | null;
  leagueSteal: (PickReview & { t: number }) | null;
  strengths: string[];
  weaknesses: string[];
  openSlots: string[];
}

const gradeOf = (pct: number) => (pct >= 0.9 ? "A" : pct >= 0.7 ? "B+" : pct >= 0.5 ? "B" : pct >= 0.3 ? "C" : "D");

function teamScore(roster: Valued[], league: League) {
  const { filled, bench } = fillLineup(roster, league);
  const starters = filled.reduce((s, f) => s + (f.v?.vorp ?? 0), 0);
  return starters + 0.35 * bench.reduce((s, v) => s + Math.max(v.vorp, 0), 0);
}

function reviewPick(k: number, v: Valued): PickReview {
  const delta = k + 1 - v.rank; // positive: taken later than our rank, so value
  const label = delta >= 12 ? "Steal" : delta >= 5 ? "Value" : delta <= -10 ? "Reach" : "Fair";
  return { k, v, delta, label };
}

/** Grades every team and explains where your draft was strong or weak. */
export function reviewDraft(picks: number[], byId: Map<number, Valued>, league: League, me: number, seq: DraftSequence = "snake"): DraftReview {
  const n = league.teams;
  const rosters: Valued[][] = Array.from({ length: n }, () => []);
  const all: (PickReview & { t: number })[] = [];
  picks.forEach((id, k) => {
    const v = byId.get(id);
    if (!v) return;
    const t = teamForPick(k, n, seq);
    rosters[t].push(v);
    all.push({ ...reviewPick(k, v), t });
  });

  const starterFp = (r: Valued[]) => fillLineup(r, league).filled.reduce((s, f) => s + (f.v?.fppg ?? 0), 0);
  const starterGames = (r: Valued[]) => {
    const s = fillLineup(r, league).filled.filter((f) => f.v);
    return s.length ? s.reduce((a, f) => a + f.v!.proj.games, 0) / s.length : 0;
  };
  const ranked = rosters.map((r, t) => ({ t, score: teamScore(r, league) })).sort((a, b) => b.score - a.score);
  const teams: TeamReview[] = ranked.map((x, i) => ({
    ...x,
    place: i + 1,
    grade: gradeOf(1 - i / Math.max(1, n - 1)),
    fppg: starterFp(rosters[x.t]),
    games: starterGames(rosters[x.t]),
    best: [...rosters[x.t]].sort((a, b) => b.vorp - a.vorp)[0] ?? null,
  }));
  const mine = teams.find((x) => x.t === me)!;

  const myPicks = all.filter((x) => x.t === me);
  const byDelta = [...myPicks].sort((a, b) => b.delta - a.delta);
  const bestPick = byDelta[0] && byDelta[0].delta > 0 ? byDelta[0] : null;
  const worst = byDelta[byDelta.length - 1];
  const worstPick = worst && worst.delta < 0 ? worst : null;
  const leagueSteal = [...all].filter((x) => x.v.rank <= picks.length).sort((a, b) => b.delta - a.delta)[0] ?? null;

  const strengths: string[] = [], weaknesses: string[] = [];
  if (league.format === "cats") {
    const cats = league.cats.filter((c) => !league.punts.includes(c));
    for (const c of cats) {
      const sums = rosters.map((r) => r.reduce((s, v) => s + (v.z[c] ?? 0), 0));
      const place = sums.filter((s) => s > sums[me]).length + 1;
      if (place <= Math.max(2, Math.round(n * 0.25))) strengths.push(`${CAT_LABEL[c]} (#${place})`);
      else if (place > n - Math.max(2, Math.round(n * 0.25))) weaknesses.push(`${CAT_LABEL[c]} (#${place})`);
    }
  } else {
    const keys = ["pts", "reb", "ast", "stl", "blk", "tpm"] as const;
    const label: Record<(typeof keys)[number], string> = { pts: "scoring", reb: "rebounding", ast: "playmaking", stl: "steals", blk: "blocks", tpm: "threes" };
    for (const k of keys) {
      const sums = rosters.map((r) => r.reduce((s, v) => s + v.proj.line[k], 0));
      const place = sums.filter((s) => s > sums[me]).length + 1;
      if (place <= 2) strengths.push(`${label[k]} (#${place})`);
      else if (place >= n - 1) weaknesses.push(`${label[k]} (#${place})`);
    }
  }
  const openSlots = fillLineup(rosters[me], league).filled.filter((f) => !f.v).map((f) => (f.slot === "UT" ? "UTIL" : f.slot));

  return { teams, mine, myPicks, bestPick, worstPick, leagueSteal, strengths, weaknesses, openSlots };
}

/* ---------------- Player notes ---------------- */

const TEAM_NAME: Record<string, string> = {
  ATL: "Atlanta", BOS: "Boston", BKN: "Brooklyn", CHA: "Charlotte", CHI: "Chicago", CLE: "Cleveland", DAL: "Dallas",
  DEN: "Denver", DET: "Detroit", GSW: "Golden State", HOU: "Houston", IND: "Indiana", LAC: "the Clippers", LAL: "the Lakers",
  MEM: "Memphis", MIA: "Miami", MIL: "Milwaukee", MIN: "Minnesota", NOP: "New Orleans", NYK: "New York", OKC: "Oklahoma City",
  ORL: "Orlando", PHI: "Philadelphia", PHX: "Phoenix", POR: "Portland", SAC: "Sacramento", SAS: "San Antonio", TOR: "Toronto",
  UTA: "Utah", WAS: "Washington",
};
const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** One line for tables: our take's headline, or his role on his team. */
export function noteLine(v: Valued): string {
  if (v.take) return v.take.headline;
  const r = v.role;
  const l = v.proj.line;
  if (!r) return `${l.min.toFixed(0)} minutes a night projected`;
  const share = Math.round(r.shotShare * 100);
  return `${r.shotRank === 1 ? "Go-to scorer" : `${ordinal(r.shotRank)} option`} in ${TEAM_NAME[r.team] ?? r.team} · ${l.min.toFixed(0)} min, ${share}% of the shots`;
}

/**
 * Takeover Fantasy's written notes on a player, generated from the numbers: his role on his team,
 * how his line changes from last season, what kind of fantasy player he is, his range of
 * outcomes, and when to draft him.
 */
export function playerNotes(v: Valued, league: League): string[] {
  const { p } = v;
  const l = v.proj.line;
  const out: string[] = [];
  const team = TEAM_NAME[p.team] ?? p.team;

  // Role.
  const r = v.role;
  if (r) {
    const share = Math.round(r.shotShare * 100);
    const who = r.shotRank === 1
      ? `${team}'s go-to scorer, ahead of ${list(r.topTeammates.slice(0, 2))}`
      : `the ${ordinal(r.shotRank)} option in ${team}, behind ${list(r.topTeammates.slice(0, Math.min(2, r.shotRank - 1)))}`;
    let s = `Projected for ${l.min.toFixed(0)} minutes and ${l.fga.toFixed(0)} shots a night (${share}% of the team's), ${who}.`;
    const cut = Math.round((1 - r.minutesFit * r.shotsFit) * 100);
    if (cut >= 3) {
      s += ` ${team}'s projections add up to more ${r.minutesFit < 0.99 ? "minutes" : "shots"} than one team can use, so we trimmed his line about ${cut}%.`;
    }
    out.push(s);
  } else if (p.team === "FA") {
    out.push("Unsigned right now; his value depends on where he lands and in what role.");
  }

  // Line versus last season.
  if (p.last && p.last.gp >= 20) {
    const d = (k: "pts" | "reb" | "ast", label: string) => {
      const x = l[k] - p.last![k];
      return Math.abs(x) >= 1 ? `${label} ${x > 0 ? "up" : "down"} ${Math.abs(x).toFixed(1)}` : null;
    };
    const moves = [d("pts", "points"), d("reb", "rebounds"), d("ast", "assists")].filter(Boolean) as string[];
    out.push(
      `Last season: ${p.last.pts.toFixed(1)} points, ${p.last.reb.toFixed(1)} rebounds and ${p.last.ast.toFixed(1)} assists in ${p.last.gp.toFixed(0)} games. `
        + (moves.length ? `We have ${list(moves)}.` : "We project about the same per game."),
    );
  } else if (p.last && p.last.gp > 0) {
    out.push(`Played only ${p.last.gp.toFixed(0)} games last season, so his line leans on ESPN's projection.`);
  } else {
    out.push("No NBA games last season, so his line comes from ESPN's projection and our reporting.");
  }

  // Fantasy profile.
  if (league.format === "points") {
    const parts: [string, number][] = [
      ["scoring", l.pts * (league.scoring.pts ?? 0)],
      ["rebounding", l.reb * (league.scoring.reb ?? 0)],
      ["passing", l.ast * (league.scoring.ast ?? 0)],
      ["steals and blocks", l.stl * (league.scoring.stl ?? 0) + l.blk * (league.scoring.blk ?? 0)],
      ["threes", l.tpm * (league.scoring.tpm ?? 0)],
    ];
    const top = parts.filter(([, x]) => x > 0).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([n]) => n);
    const tags = edgeTags(l).filter((t) => !/monster|volume|engine|cleaner/i.test(t)).map((t) => t.toLowerCase());
    out.push(
      `In your scoring he's worth ${v.fppg.toFixed(1)} a night, mostly from ${list(top)}.`
        + (tags.length ? ` Watch out for: ${list(tags)}.` : ""),
    );
  } else {
    const cats = league.cats.filter((c) => !league.punts.includes(c));
    const zs = cats.map((c) => ({ c, z: v.z[c] ?? 0 })).sort((a, b) => b.z - a.z);
    const good = zs.filter((x) => x.z >= 0.8).slice(0, 3).map((x) => CAT_LABEL[x.c]);
    const bad = zs.filter((x) => x.z <= -0.8).slice(-2).map((x) => CAT_LABEL[x.c]);
    out.push(
      (good.length ? `A category winner in ${list(good)}.` : "No standout category; his value is in balance.")
        + (bad.length ? ` He costs you in ${list(bad)}, so he fits builds that punt ${bad.length > 1 ? "those" : "it"}.` : ""),
    );
  }

  // Range of outcomes.
  const c = v.ceiling;
  if (c.label !== "Steady" && c.rank < v.rank - 5) {
    out.push(`${c.label}: if things break right he's a top-${c.rank} player${c.reasons.length ? ` (${c.reasons.slice(0, 2).join("; ").toLowerCase()})` : ""}.`);
  } else if (v.proj.games < 62) {
    out.push(`The risk is availability: we expect ${v.proj.games.toFixed(0)} games.`);
  } else {
    out.push("A steady pick: what you see is about what you get.");
  }

  // When to draft him.
  const n = league.teams;
  const ourRound = Math.ceil(v.rank / n);
  if (p.adp != null) {
    const adpRound = Math.ceil(p.adp / n);
    out.push(
      adpRound > ourRound
        ? `Drafters take him around pick ${p.adp.toFixed(0)} (round ${adpRound}); he's worth a round-${ourRound} pick to us, so you can get him at a discount.`
        : adpRound < ourRound
          ? `Drafters take him around pick ${p.adp.toFixed(0)} (round ${adpRound}), earlier than his round-${ourRound} value here. Let someone else reach.`
          : `Usually goes around pick ${p.adp.toFixed(0)}, right where we'd take him (round ${ourRound}).`,
    );
  }
  return out;
}

/* ---------------- Weekly head-to-head ---------------- */

/** Games an NBA team plays in a typical fantasy week. */
const GAMES_PER_WEEK = 3.4;
const WEEKS = 20;

function phi(z: number) {
  // Standard normal CDF (Abramowitz-Stegun approximation).
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

interface H2HTeam {
  t: number;
  /** Chance of beating each other team in a week (index = team; NaN for itself). */
  vs: number[];
  /** Average chance of winning a week, and the season record that implies over 20 weeks. */
  winRate: number;
  record: string;
  /** Points leagues: projected fantasy points in a typical week. */
  weekly: number | null;
  /** Category leagues: this team's rank in each category (1 = best). */
  catRank: Partial<Record<Cat, number>>;
}

/**
 * How often each drafted team would win a week against each other team, from its starters'
 * projections. Points: a normal model of weekly totals. Categories: each category's chance, then
 * the chance of winning more than half of them.
 */
export function h2hReport(rosters: Valued[][], league: League): H2HTeam[] {
  const n = rosters.length;
  const starters = rosters.map((r) => fillLineup(r, league).filled.map((f) => f.v).filter(Boolean) as Valued[]);
  const share = (v: Valued) => Math.min(1, v.proj.games / 82) * GAMES_PER_WEEK;
  const vs: number[][] = Array.from({ length: n }, () => Array(n).fill(NaN));
  let weekly: (number | null)[] = Array(n).fill(null);
  const catRank: Partial<Record<Cat, number>>[] = Array.from({ length: n }, () => ({}));

  if (league.format === "points") {
    const mu = starters.map((s) => s.reduce((a, v) => a + v.fppg * share(v), 0));
    // A player's single-game score varies ~35% around his average; schedules add ~8% at team level.
    const sd = starters.map((s, i) => Math.sqrt(s.reduce((a, v) => a + share(v) * (0.35 * v.fppg) ** 2, 0) + (0.08 * mu[i]) ** 2));
    weekly = mu;
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) if (a !== b) vs[a][b] = phi((mu[a] - mu[b]) / Math.sqrt(sd[a] ** 2 + sd[b] ** 2 || 1));
  } else {
    const cats = league.cats.filter((c) => !league.punts.includes(c));
    const total = (s: Valued[], c: Cat) => {
      if (c === "fg%" || c === "ft%") {
        const [m, x] = c === "fg%" ? ["fgm", "fga"] as const : ["ftm", "fta"] as const;
        const made = s.reduce((a, v) => a + v.proj.line[m] * share(v), 0), att = s.reduce((a, v) => a + v.proj.line[x] * share(v), 0);
        return att ? made / att : 0;
      }
      return s.reduce((a, v) => a + (v.proj.line[c as keyof typeof v.proj.line] ?? 0) * share(v), 0);
    };
    const tot = cats.map((c) => starters.map((s) => total(s, c)));
    cats.forEach((c, ci) => {
      const xs = tot[ci];
      const m = xs.reduce((a, b) => a + b, 0) / n;
      // Week-to-week noise per category, scaled to how spread out the league is (and never zero).
      const spread = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / n) || 1e-6;
      const noise = Math.max(spread, (c === "fg%" || c === "ft%" ? 0.012 : 0.08 * Math.abs(m)));
      const better = (a: number, b: number) => (c === "tov" ? b - a : a - b);
      xs.forEach((x, i) => { catRank[i][c] = xs.filter((y) => better(y, x) > 0).length + 1; });
      (tot[ci] as number[] & { p?: number[][] }).p = xs.map((xa) => xs.map((xb) => phi(better(xa, xb) / (noise * Math.SQRT2))));
    });
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
      if (a === b) continue;
      // Chance of winning more than half the categories (ties count half).
      let dist = [1];
      for (const t of tot) {
        const p = (t as number[] & { p: number[][] }).p[a][b];
        const next = Array(dist.length + 1).fill(0);
        dist.forEach((q, k) => { next[k] += q * (1 - p); next[k + 1] += q * p; });
        dist = next;
      }
      const k = cats.length;
      vs[a][b] = dist.reduce((acc, q, won) => acc + (won * 2 > k ? q : won * 2 === k ? q / 2 : 0), 0);
    }
  }

  return rosters.map((_, t) => {
    const ps = vs[t].filter((x) => !Number.isNaN(x));
    const winRate = ps.reduce((a, b) => a + b, 0) / (ps.length || 1);
    const w = Math.round(winRate * WEEKS);
    return { t, vs: vs[t], winRate, record: `${w}-${WEEKS - w}`, weekly: weekly[t], catRank: catRank[t] };
  });
}
