import { Player, Pos, StatKey, StatLine, STAT_KEYS } from "./types";
import { Take, applyMult, findTake, hasRoleChange, takeLine } from "./takes";

/* ---------------- League settings ---------------- */

export type PointsScoring = Partial<Record<StatKey, number>>;
export type Cat = "pts" | "reb" | "ast" | "stl" | "blk" | "tpm" | "tov" | "fg%" | "ft%" | "dd" | "oreb";
export type Slot = Pos | "G" | "F" | "UT";

export interface League {
  presetId: string;
  format: "points" | "cats";
  scoring: PointsScoring; // points leagues
  cats: Cat[]; // category leagues
  punts: Cat[];
  teams: number;
  slots: Record<Slot, number>; // starting lineup slots
  bench: number;
}

const ESPN_SLOTS: Record<Slot, number> = { PG: 1, SG: 1, SF: 1, PF: 1, C: 1, G: 1, F: 1, UT: 3 };
const YAHOO_SLOTS: Record<Slot, number> = { PG: 1, SG: 1, SF: 1, PF: 1, C: 2, G: 1, F: 1, UT: 2 };

export const NINE_CAT: Cat[] = ["fg%", "ft%", "tpm", "pts", "reb", "ast", "stl", "blk", "tov"];

export const PRESETS: { id: string; label: string; league: Omit<League, "teams" | "punts"> }[] = [
  {
    id: "espn-points",
    label: "ESPN Points (default)",
    league: {
      presetId: "espn-points",
      format: "points",
      // ESPN default H2H points scoring
      scoring: { pts: 1, tpm: 1, fga: -1, fgm: 2, fta: -1, ftm: 1, reb: 1, ast: 2, stl: 4, blk: 4, tov: -2 },
      cats: NINE_CAT,
      slots: ESPN_SLOTS,
      bench: 3,
    },
  },
  {
    id: "yahoo-points",
    label: "Yahoo Points (default)",
    league: {
      presetId: "yahoo-points",
      format: "points",
      scoring: { pts: 1, reb: 1.2, ast: 1.5, stl: 3, blk: 3, tov: -1 },
      cats: NINE_CAT,
      slots: YAHOO_SLOTS,
      bench: 3,
    },
  },
  {
    id: "espn-9cat",
    label: "ESPN 9-Cat",
    league: { presetId: "espn-9cat", format: "cats", scoring: {}, cats: NINE_CAT, slots: ESPN_SLOTS, bench: 3 },
  },
  {
    id: "yahoo-9cat",
    label: "Yahoo 9-Cat",
    league: { presetId: "yahoo-9cat", format: "cats", scoring: {}, cats: NINE_CAT, slots: YAHOO_SLOTS, bench: 3 },
  },
  {
    id: "8cat",
    label: "8-Cat (no TO)",
    league: {
      presetId: "8cat",
      format: "cats",
      scoring: {},
      cats: NINE_CAT.filter((c) => c !== "tov"),
      slots: ESPN_SLOTS,
      bench: 3,
    },
  },
];

export function leagueFromPreset(id: string, teams = 10): League {
  const p = PRESETS.find((x) => x.id === id) ?? PRESETS[0];
  return { ...structuredClone(p.league), teams, punts: [] };
}

export const rosterSize = (l: League) =>
  Object.values(l.slots).reduce((a, b) => a + b, 0) + l.bench;

/* ---------------- Projection model ---------------- */

const MIN_SAMPLE_GP = 15;
/** Stats ESPN's preseason projections don't include. */
const UNPROJECTED = new Set<StatKey>(["oreb", "dreb", "dd", "td"]);
const FULL_SAMPLE_GP = 60;
/** Games a healthy starter plays, and how often you can actually plug a replacement into a missed one. */
const FULL_SEASON_GAMES = 72;
const STREAM_FILL_RATE = 0.7;
const AGE_RISK_FROM = 32;

/**
 * Expected year-over-year change in per-game production at a given age. Roughly the shape of
 * published NBA aging curves: steep gains through 22, flat in the prime, slow decline after 32.
 */
function ageCurve(age: number | null): number {
  if (age == null) return 1;
  if (age <= 20) return 1.1;
  if (age === 21) return 1.07;
  if (age === 22) return 1.05;
  if (age === 23) return 1.03;
  if (age === 24) return 1.01;
  if (age >= 36) return 0.95;
  if (age >= 33) return 0.97;
  return 1;
}

/** Scale production but not turnovers or games (a bigger role does not mean cleaner play). */
function scaleLine(l: StatLine, f: number): StatLine {
  const out = { ...l };
  for (const k of STAT_KEYS) if (k !== "tov" && k !== "min") out[k] = l[k] * f;
  return out;
}

function halfway(a: StatLine, b: StatLine): StatLine {
  const out = { ...a };
  for (const k of STAT_KEYS) out[k] = (a[k] + b[k]) / 2;
  return out;
}

export interface Projection {
  line: StatLine; // per game
  games: number;
  basis: string;
}

/**
 * Our projection: blend ESPN's preseason projection with last season's
 * actual production (regressed), then apply a durability-aware games estimate.
 * In-season, current stats get blended in proportionally to games played.
 */
function project(p: Player, take?: Take | null): Projection | null {
  const { proj, cur } = p;
  const lastGp = p.last?.gp ?? 0;
  // A handful of games (or a lost season) says nothing about per-game production.
  // Last season is aged one year forward: young players improve, old ones slip.
  const rawLast = lastGp < MIN_SAMPLE_GP && proj ? null : p.last;
  const curve = ageCurve(p.age);
  const last = rawLast && curve !== 1 ? scaleLine(rawLast, curve) : rawLast;
  const rookieLine = take ? takeLine(take) : null;
  if (!proj && !last && !cur && !rookieLine) return null;
  // Unsigned with no take of ours: retired, overseas, or out of the league. Not draftable.
  if (p.team === "FA" && !cur && !take) return null;
  const roleChange = !!take && !rookieLine && hasRoleChange(take);

  let line = {} as StatLine;
  let basis: string;
  let wProj = 0, wLast = 0, wCur = 0;
  const src = rookieLine ?? last;
  if (rookieLine) {
    wProj = proj ? 0.5 : 0; wLast = proj ? 0.5 : 1; basis = "take+espn";
  } else if (proj && last) {
    // Last season counts for up to 40%, less when it was cut short: an injury-hit year is usually
    // a player at less than full strength, and a small sample besides.
    wLast = 0.4 * Math.min(1, lastGp / FULL_SAMPLE_GP); wProj = 1 - wLast; basis = "blend";
  } else if (proj) {
    wProj = 1; basis = "espn-proj";
  } else {
    wLast = 1; basis = "last-season";
  }
  if (cur && cur.gp > 0) {
    // weight current season more as sample grows (full trust ~40 games)
    wCur = Math.min(0.85, cur.gp / 40);
    wProj *= 1 - wCur; wLast *= 1 - wCur;
    basis += "+current";
  }
  for (const k of STAT_KEYS) {
    // ESPN's preseason projections leave some stats at 0; carry last season's in their place
    // instead of shrinking it to the blend weight.
    const unprojected = UNPROJECTED.has(k) && !proj?.[k] && !!src?.[k];
    line[k] = unprojected
      ? (src?.[k] ?? 0) * (wProj + wLast) + (cur?.[k] ?? 0) * wCur
      : (proj?.[k] ?? 0) * wProj + (src?.[k] ?? 0) * wLast + (cur?.[k] ?? 0) * wCur;
  }
  // A take's role change moves the blended line halfway: ESPN's projection already prices in some
  // of the news, last season none of it.
  if (roleChange) { line = halfway(line, applyMult(line, take!)); basis = `take-${basis}`; }
  // Games: ESPN projections tend to be optimistic for injury-prone players.
  let games: number;
  if (take?.games != null) games = take.games;
  // One injury-hit season is a warning, not a forecast: it counts for a third, and can pull the
  // estimate down only as far as 70% of ESPN's number.
  else if (proj && lastGp > 0) games = 0.65 * proj.gp + 0.35 * Math.max(Math.min(lastGp, 82), 0.7 * proj.gp);
  else if (proj) games = proj.gp * 0.95;
  else games = Math.min(lastGp, 78) * 0.95;
  games = Math.max(0, Math.min(games, 79));
  if (p.injury === "OUT" && take?.games == null) games *= 0.85;
  if (take?.games == null) {
    // Availability falls off with age: 2% fewer games per year past 32, up to 20%.
    if (p.age != null && p.age > AGE_RISK_FROM) { games *= Math.max(0.8, 1 - 0.02 * (p.age - AGE_RISK_FROM)); basis += "+age"; }
    // Unsigned with no ESPN projection: he may not have a job, let alone last season's role.
    if (p.team === "FA" && !proj) { games *= 0.4; basis += "+unsigned"; }
  }
  line.gp = games;
  return { line, games, basis };
}

/* ---------------- Team fit ---------------- */

const TEAM_MINUTES = 240;
const TEAM_SHOTS = 89;
const SHOT_STATS: StatKey[] = ["pts", "fgm", "fga", "ftm", "fta", "tpm", "tpa"];

/**
 * Projections are made one player at a time, so a team's players can add up to more minutes and
 * shots than one team can use (Washington's projected four starters alone took ~62 shots a game).
 * This trims them back to what fits:
 *  - Minutes: anything over 240 a game (weighted by games played) comes mostly out of the bench,
 *    and everything a player produces shrinks with his minutes.
 *  - Shots: teams whose players shoot at a rate well above the league's typical team get their
 *    shots and points scaled down, partly, since projections at team level are noisy.
 * Mutates the projected lines; returns each player's role on his team.
 */
function fitTeams(base: { p: Player; proj: Projection }[]): Map<number, TeamRole> {
  const byTeam = new Map<string, { p: Player; proj: Projection }[]>();
  for (const x of base) if (x.p.team !== "FA") (byTeam.get(x.p.team) ?? byTeam.set(x.p.team, []).get(x.p.team)!).push(x);
  const w = (x: { proj: Projection }) => Math.min(1, x.proj.games / 82);

  // 1. Minutes.
  const minutesFit = new Map<number, number>();
  for (const xs of byTeam.values()) {
    const total = xs.reduce((s, x) => s + x.proj.line.min * w(x), 0);
    const excess = total - TEAM_MINUTES;
    if (excess <= 0) continue;
    // Bench players give up more: weight by how far below 36 minutes they are.
    const give = xs.map((x) => Math.max(2, 36 - x.proj.line.min) * w(x));
    const sum = give.reduce((a, b) => a + b, 0);
    xs.forEach((x, i) => {
      const cut = Math.min(0.4 * x.proj.line.min, (excess * give[i]) / sum / Math.max(w(x), 0.1));
      const f = x.proj.line.min ? (x.proj.line.min - cut) / x.proj.line.min : 1;
      minutesFit.set(x.p.id, f);
      x.proj.line = scaleAll(x.proj.line, f);
    });
  }

  // 2. Shot rate, relative to the typical team.
  const rate = (xs: { proj: Projection }[]) => {
    const fga = xs.reduce((s, x) => s + x.proj.line.fga * w(x), 0);
    const min = xs.reduce((s, x) => s + x.proj.line.min * w(x), 0);
    return min ? (fga * TEAM_MINUTES) / min : 0;
  };
  const rates = [...byTeam.values()].map(rate).sort((a, b) => a - b);
  const typical = rates[Math.floor(rates.length / 2)] ?? 0;
  const shotsFit = new Map<number, number>();
  for (const xs of byTeam.values()) {
    const r = rate(xs);
    if (!typical || r <= typical * 1.03) continue;
    const f = Math.pow((typical * 1.03) / r, 0.7);
    // The team's go-to scorer keeps his shots; the cut lands more on the second and third options.
    const order = [...xs].sort((a, b) => b.proj.line.fga * w(b) - a.proj.line.fga * w(a));
    const k = new Map(order.map((x, i) => [x, 0.4 + (1.2 * i) / Math.max(1, order.length - 1)]));
    const shots = (x: { proj: Projection }) => x.proj.line.fga * w(x);
    const norm = xs.reduce((sum, x) => sum + shots(x), 0) / (xs.reduce((sum, x) => sum + k.get(x)! * shots(x), 0) || 1);
    for (const x of xs) {
      const fi = Math.max(0.75, 1 - (1 - f) * k.get(x)! * norm);
      shotsFit.set(x.p.id, fi);
      const l = { ...x.proj.line };
      for (const key of SHOT_STATS) l[key] *= fi;
      l.ast *= 1 - (1 - fi) * 0.5;
      x.proj.line = l;
    }
  }

  // 3. Roles.
  const roles = new Map<number, TeamRole>();
  for (const [team, xs] of byTeam) {
    const shots = xs.map((x) => ({ x, s: x.proj.line.fga * w(x) })).sort((a, b) => b.s - a.s);
    // A team takes about 89 shots a game; our pool can miss deep-bench players, so never divide by less.
    const teamShots = Math.max(TEAM_SHOTS, shots.reduce((a, b) => a + b.s, 0));
    shots.forEach(({ x }, i) => {
      roles.set(x.p.id, {
        team,
        // Share of the team's shots on nights he plays.
        shotShare: x.proj.line.fga / teamShots,
        shotRank: i + 1,
        topTeammates: shots.filter((o) => o.x !== x).slice(0, 3).map((o) => o.x.p.name),
        minutesFit: minutesFit.get(x.p.id) ?? 1,
        shotsFit: shotsFit.get(x.p.id) ?? 1,
      });
    });
  }
  return roles;
}

function scaleAll(l: StatLine, f: number): StatLine {
  const out = { ...l };
  for (const k of STAT_KEYS) out[k] = l[k] * f;
  return out;
}

/* ---------------- Valuation ---------------- */

export function fantasyPoints(line: StatLine, scoring: PointsScoring) {
  let s = 0;
  for (const [k, w] of Object.entries(scoring)) s += (line[k as StatKey] ?? 0) * (w ?? 0);
  return s;
}

export interface Valued {
  p: Player;
  proj: Projection;
  fppg: number; // points leagues
  total: number; // value used for ranking before replacement level
  z: Partial<Record<Cat, number>>; // cats leagues, per-cat z
  vorp: number;
  rank: number;
  posRank: Record<string, number>;
  tier: number;
  /**
   * core = worth a pick in this league; flier = last-round upside pick; sleeper = past the draftable
   * pool but one role change from mattering; waiver = leave on the wire.
   */
  bucket: "core" | "flier" | "sleeper" | "waiver";
  take: Take | null;
  /** What his season looks like if things break right. */
  ceiling: Ceiling;
  /** Our rank, when you've set your own rank for him (rank then holds yours). */
  cvRank?: number;
  /** His share of his team's minutes and shots, after the team-level fit. Null for free agents. */
  role: TeamRole | null;
}

export interface TeamRole {
  team: string;
  /** Share of the team's projected shots, 0-1. */
  shotShare: number;
  /** 1 = takes the most shots on his team. */
  shotRank: number;
  /** The team's other top shot-takers, most shots first. */
  topTeammates: string[];
  /** How much we cut his minutes (and everything with them) to fit 240 team minutes. 1 = no cut. */
  minutesFit: number;
  /** How much we cut his shots and points because his team's projections take too many shots. */
  shotsFit: number;
}

export interface Ceiling {
  /** Value over replacement in the good scenario, on the same scale as vorp. */
  vorp: number;
  /** Where that would rank on today's board. */
  rank: number;
  /** Projected season fantasy points in the good scenario (points leagues). */
  total: number;
  /** How wide the range of outcomes is. */
  label: "Boom or bust" | "Some upside" | "Steady";
  reasons: string[];
}

const catRaw = (l: StatLine, c: Cat): number => {
  switch (c) {
    case "fg%": return l.fga ? l.fgm / l.fga : 0;
    case "ft%": return l.fta ? l.ftm / l.fta : 0;
    default: return l[c as StatKey] ?? 0;
  }
};

function mean(a: number[]) { return a.reduce((x, y) => x + y, 0) / (a.length || 1); }
function sd(a: number[]) {
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2))) || 1;
}

function catZScores(pool: { line: StatLine }[], all: { line: StatLine }[], cats: Cat[]) {
  const res = all.map(() => ({} as Partial<Record<Cat, number>>));
  for (const c of cats) {
    let vals: number[]; let poolVals: number[];
    if (c === "fg%" || c === "ft%") {
      // impact = attempts * (pct - league pct); volume matters
      const [m, a] = c === "fg%" ? ["fgm", "fga"] as const : ["ftm", "fta"] as const;
      const lgPct = pool.reduce((s, x) => s + x.line[m], 0) / (pool.reduce((s, x) => s + x.line[a], 0) || 1);
      const imp = (l: StatLine) => l[m] - lgPct * l[a];
      vals = all.map((x) => imp(x.line));
      poolVals = pool.map((x) => imp(x.line));
    } else {
      vals = all.map((x) => catRaw(x.line, c));
      poolVals = pool.map((x) => catRaw(x.line, c));
    }
    const m = mean(poolVals), s = sd(poolVals);
    const sign = c === "tov" ? -1 : 1;
    vals.forEach((v, i) => (res[i][c] = (sign * (v - m)) / s));
  }
  return res;
}

const SLOT_ELIG: Record<Slot, Pos[]> = {
  PG: ["PG"], SG: ["SG"], SF: ["SF"], PF: ["PF"], C: ["C"],
  G: ["PG", "SG"], F: ["SF", "PF"], UT: ["PG", "SG", "SF", "PF", "C"],
};

/** Value every player under a league's settings and rank by value over replacement. */
export function valuePlayers(players: Player[], league: League, useTakes = true): Valued[] {
  const takeOf = new Map<number, Take>();
  if (useTakes) for (const p of players) { const t = findTake(p.name); if (t) takeOf.set(p.id, t); }
  const base = players
    .map((p) => ({ p, proj: project(p, takeOf.get(p.id)) }))
    // A take saying he's out for the season (0 games) keeps him on the board, at the bottom, so
    // people searching for him see why instead of finding nothing.
    .filter((x): x is { p: Player; proj: Projection } => !!x.proj && (x.proj.games > 0 || takeOf.get(x.p.id)?.games === 0));
  const roles = fitTeams(base);

  const draftable = league.teams * rosterSize(league);
  let scored: { p: Player; proj: Projection; fppg: number; total: number; z: Partial<Record<Cat, number>> }[];

  if (league.format === "points") {
    scored = base.map(({ p, proj }) => {
      const fppg = fantasyPoints(proj.line, league.scoring);
      return { p, proj, fppg, total: fppg * proj.games, z: {} };
    });
  } else {
    const cats = league.cats.filter((c) => !league.punts.includes(c));
    const lines = base.map((b) => ({ line: b.proj.line }));
    // two-pass: rough pool from pts+reb+ast, then refine pool by z-sum
    let order = base.map((b, i) => ({ i, v: b.proj.line.pts + b.proj.line.reb + b.proj.line.ast + 2 * (b.proj.line.stl + b.proj.line.blk) }));
    let zs = catZScores(order.sort((a, b) => b.v - a.v).slice(0, draftable).map((o) => lines[o.i]), lines, cats);
    for (let pass = 0; pass < 2; pass++) {
      order = zs.map((z, i) => ({ i, v: Object.values(z).reduce((a, b) => a + (b ?? 0), 0) }));
      zs = catZScores(order.sort((a, b) => b.v - a.v).slice(0, draftable).map((o) => lines[o.i]), lines, cats);
    }
    scored = base.map(({ p, proj }, i) => {
      const zsum = Object.values(zs[i]).reduce((a, b) => a + (b ?? 0), 0);
      // availability: H2H cats reward playing; scale by games relative to 70
      const avail = Math.min(1.1, proj.games / 70);
      const total = zsum >= 0 ? zsum * avail : zsum / Math.max(avail, 0.5);
      return { p, proj, fppg: 0, total, z: zs[i] };
    });
  }

  // Replacement level via greedy league-wide lineup fill.
  scored.sort((a, b) => b.total - a.total);
  const slotsLeft: Record<string, number> = {};
  for (const [s, n] of Object.entries(league.slots)) slotsLeft[s] = n * league.teams;
  const order: Slot[] = ["C", "PG", "SG", "SF", "PF", "G", "F", "UT"];
  const starters = new Set<number>();
  for (const x of scored) {
    const slot = order.find((s) => slotsLeft[s] > 0 && SLOT_ELIG[s].some((pp) => x.p.pos.includes(pp)));
    if (slot) { slotsLeft[slot]--; starters.add(x.p.id); }
    if (Object.values(slotsLeft).every((n) => n <= 0)) break;
  }
  const benchPool = scored.filter((x) => !starters.has(x.p.id));
  const repl: Record<Pos, number> = { PG: 0, SG: 0, SF: 0, PF: 0, C: 0 };
  // replacement = best player at each position beyond starters + bench depth
  const benchDepth = league.teams * league.bench;
  for (const pos of Object.keys(repl) as Pos[]) {
    const atPos = benchPool.filter((x) => x.p.pos.includes(pos));
    const idx = Math.min(atPos.length - 1, Math.round(benchDepth / 5));
    repl[pos] = atPos[Math.max(idx, 0)]?.total ?? 0;
  }

  const valued: Valued[] = scored.map((x) => {
    const r = x.p.pos.length ? Math.min(...x.p.pos.map((pp) => repl[pp])) : Math.max(...Object.values(repl));
    // In points leagues a missed game isn't a zero: a replacement-level player fills the slot most
    // of the time. Without this credit, anyone with injury risk is punished twice.
    const missed = league.format === "points" && r > 0 && !x.proj.basis.includes("unsigned")
      ? STREAM_FILL_RATE * (r / FULL_SEASON_GAMES) * Math.max(0, FULL_SEASON_GAMES - x.proj.games)
      : 0;
    const vorp = x.total - r + missed;
    const take = takeOf.get(x.p.id) ?? null;
    return { ...x, vorp, rank: 0, posRank: {}, tier: 0, bucket: "core", take, ceiling: ceilingFor(x, take, league, vorp), role: roles.get(x.p.id) ?? null } as Valued;
  });
  valued.sort((a, b) => b.vorp - a.vorp);
  // Rank each ceiling against today's board.
  const vorps = valued.map((v) => v.vorp);
  for (const v of valued) v.ceiling.rank = vorps.filter((x) => x > v.ceiling.vorp).length + 1;
  const posCount: Record<string, number> = {};
  valued.forEach((v, i) => {
    v.rank = i + 1;
    for (const pp of v.p.pos) v.posRank[pp] = posCount[pp] = (posCount[pp] ?? 0) + 1;
  });
  assignTiers(valued, draftable);
  return valued;
}

/**
 * The good-case season: the higher of our line and ESPN's, lifted by the things that create
 * upside (youth, a new or bigger role, a short or missing track record), over a full workload.
 * Late in a draft that is what you are buying: a bust is cut for a waiver pickup, a hit wins leagues.
 */
function ceilingFor(
  x: { p: Player; proj: Projection; fppg: number; total: number },
  take: Take | null, league: League, vorp: number,
): Ceiling {
  const { p, proj } = x;
  const reasons: string[] = [];
  let lift = 0;
  const age = p.age;
  if (age != null && age <= 24) {
    lift += age <= 20 ? 0.12 : age === 21 ? 0.09 : age === 22 ? 0.07 : age === 23 ? 0.05 : 0.03;
    reasons.push(age <= 21 ? `${age} years old: still improving fast` : `${age} and still on the rise`);
  }
  if (take && (take.kind === "boost" || take.kind === "rookie")) {
    lift += 0.05;
    reasons.push(take.kind === "rookie" ? "Rookie with a real role" : "Role is growing");
  }
  const lastMin = p.last && p.last.gp >= MIN_SAMPLE_GP ? p.last.min : null;
  if (p.proj && ((lastMin != null && p.proj.min - lastMin >= 3) || (lastMin == null && p.proj.min >= 24))) {
    lift += 0.04;
    reasons.push(lastMin != null ? `Minutes jump: ${lastMin.toFixed(0)} → ${p.proj.min.toFixed(0)}` : `Projected for ${p.proj.min.toFixed(0)} minutes`);
  }
  if (!p.last || p.last.gp < 40) {
    lift += 0.04;
    reasons.push(p.last ? `Only ${p.last.gp.toFixed(0)} games last season: wide range of outcomes` : "No NBA track record: wide range of outcomes");
  }
  lift = Math.min(lift, 0.25);

  // Good-case games: halfway to a full workload. Veterans don't get this: rest days are the plan.
  const fullGames = Math.min(76, Math.max(proj.games, p.proj?.gp ?? proj.games));
  const games = age != null && age > AGE_RISK_FROM ? proj.games : proj.games + (fullGames - proj.games) * 0.5;
  if (games - proj.games >= 6) reasons.push(`Plays ${games.toFixed(0)} games instead of ${proj.games.toFixed(0)}`);

  let total: number, ceilVorp: number;
  if (league.format === "points") {
    const espnFp = p.proj ? fantasyPoints(p.proj, league.scoring) : 0;
    const fp = Math.max(x.fppg, espnFp) * (1 + lift);
    total = fp * games;
    ceilVorp = vorp + (total - x.total);
  } else {
    // Category value scales with production and with games.
    const scale = (1 + lift) * (games / Math.max(proj.games, 1));
    total = x.total >= 0 ? x.total * scale : x.total / scale;
    ceilVorp = vorp + (total - x.total) + Math.max(0, lift) * 2;
  }
  const label = lift >= 0.12 ? "Boom or bust" : lift >= 0.06 ? "Some upside" : "Steady";
  return { vorp: ceilVorp, rank: 0, total, label, reasons };
}

/** Players past the draftable pool who are still worth a last-round dart, as a share of the pool. */
const FLIER_SHARE = 0.25;
const MAX_TIERS = 6;

/**
 * At most MAX_TIERS tiers over the players who actually get drafted in this league (teams x roster
 * size), split at the largest value gaps. Tiers get wider further down the board, where the gaps
 * between players stop meaning much. Past the pool come a short tier of fliers, then everyone
 * else: waiver-wire players nobody should spend a pick on.
 */
function assignTiers(v: Valued[], draftable: number) {
  if (!v.length) return;
  const n = Math.min(v.length, Math.max(20, draftable));
  const fliers = Math.max(10, Math.round(n * FLIER_SHARE));
  const minSize = (i: number) => 3 + Math.floor(i / 12) * 2;
  const gaps = Array.from({ length: n - 1 }, (_, i) => ({ at: i + 1, gap: v[i].vorp - v[i + 1].vorp }))
    .sort((a, b) => b.gap - a.gap);
  const breaks: number[] = [];
  for (const g of gaps) {
    if (breaks.length >= MAX_TIERS - 1) break;
    const need = minSize(g.at);
    if (g.at < 3 || n - g.at < need) continue;
    if (breaks.every((b) => Math.abs(b - g.at) >= need)) breaks.push(g.at);
  }
  breaks.sort((a, b) => a - b);
  let tier = 1, next = 0;
  v.forEach((x, i) => {
    if (i >= n) {
      const flier = i < n + fliers;
      // Past the fliers, anyone with a real path to a bigger role stays on the radar.
      const sleeper = !flier && (x.ceiling.label !== "Steady" || x.take?.kind === "boost" || x.take?.kind === "rookie");
      x.tier = breaks.length + (flier ? 2 : sleeper ? 3 : 4);
      x.bucket = flier ? "flier" : sleeper ? "sleeper" : "waiver";
      return;
    }
    if (next < breaks.length && i === breaks[next]) { tier++; next++; }
    x.tier = tier;
  });
}

export const tierLabel = (v: Pick<Valued, "tier" | "bucket">) =>
  v.bucket === "flier" ? "Flier" : v.bucket === "sleeper" ? "Sleeper" : v.bucket === "waiver" ? "Waiver" : String(v.tier);

/* ---------------- Explanations ---------------- */

export function edgeTags(line: StatLine): string[] {
  const tags: string[] = [];
  const missFG = line.fga - line.fgm, missFT = line.fta - line.ftm;
  if (line.stl + line.blk >= 2.5) tags.push("Stocks monster");
  if (line.tpm >= 2.8) tags.push("3PT volume");
  if (line.fga >= 12 && line.fga && line.fgm / line.fga < 0.44) tags.push("Inefficient FG");
  if (line.fta >= 4 && line.ftm / line.fta < 0.7) tags.push("FT% drag");
  if (missFG + missFT >= 11) tags.push("Lots of misses");
  if (line.tov >= 3.2) tags.push("Turnover-heavy");
  if (line.ast >= 7) tags.push("Assist engine");
  if (line.reb >= 10) tags.push("Glass cleaner");
  return tags;
}
