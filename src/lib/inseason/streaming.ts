/**
 * Streaming engine
 * Finds the add/drops that add the most fantasy points this matchup week. The point is usable
 * games, not raw games: a pickup only helps on days it gets into the lineup, so every day's
 * lineup is filled the way ESPN would (best players into the slots they're eligible for), and a
 * move is scored by how much the week's started points go up.
 */

import type { FreeAgentEntry, LeagueSnapshot, MatchupWeekSchedule, Player, PlayerStatus } from '@/types';
import { chanceOn } from './availability';
import { currentPeriod } from './matchupGames';
import { boostOn, longBoost, teammateBoosts, type TeammateBoost } from './opportunity';

const BENCH_SLOT = 12;
const IR_SLOT = 13;
/** Minimum points a move must add to be worth a pickup (points leagues). */
const MIN_POINTS_GAIN = 8;
/** Waiver claims need about two days to clear, so they don't count until then. */
const WAIVER_DELAY_DAYS = 2;
/** Most moves to suggest when the league has no weekly pickup limit. */
const MAX_MOVES = 4;
/** A dropped player rostered in at least this share of ESPN leagues will probably get claimed. */
const LIKELY_CLAIMED_PCT = 15;
/** Show turn-of-the-week pickups once this many game days (or fewer) are left in the week. */
const BRIDGE_DAYS_LEFT = 2;
/** Next week's first days that a turn-of-the-week pickup should also play. */
const BRIDGE_NEXT_DAYS = 2;
const BRIDGE_PICKS = 6;

/** Chance he plays tonight from the tag alone (the lineup check, which has no return dates). */
const PLAY_CHANCE: Partial<Record<PlayerStatus, number>> = {
  OUT: 0,
  INJURY_RESERVE: 0,
  SUSPENSION: 0,
  DOUBTFUL: 0.25,
  QUESTIONABLE: 0.6,
  DAY_TO_DAY: 0.6,
};

/** Today's date in US Eastern time (NBA game days), as YYYY-MM-DD. */
const easternDate = (ms: number) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);


export interface StreamPlayer {
  id: number;
  name: string;
  nbaTeamAbbrev?: string;
  positions: string[];
  status: PlayerStatus;
  /** Fantasy points per game we expect. */
  fppg: number;
  gamesLeft: number;
  /** Games left this week that make the lineup. */
  usableLeft: number;
  /** Games next matchup week (when we know next week's schedule). */
  gamesNext?: number;
  /** Extra minutes while teammates are out, e.g. "+6 min with Stephen Curry out (back about Oct 29)". */
  opportunity?: string;
}

export interface StreamMove {
  drop: StreamPlayer;
  add: StreamPlayer & { onWaivers: boolean; percentOwned?: number };
  /** Fantasy points the move adds to this week's started total. */
  pointsGain: number;
  usableGamesGain: number;
  reason: string;
  /** Set when it's better to wait: make the move after this day's games (US date and label). */
  swapAfter?: { date: string; label: string };
  /** What the move does to next week, if you kept the added player. */
  nextWeek?: { pointsChange: number; addGames: number; dropGames: number };
  /** Set when the move costs points next week, e.g. dropping someone with a big week coming. */
  nextWeekWarning?: string;
  /**
   * upgrade: at least as good per game, keep him. opportunity: as good while a teammate is out
   * for weeks, keep him until then. stream: a short-term pickup (this week's games, or a teammate
   * out for a game or two).
   */
  kind: 'upgrade' | 'opportunity' | 'stream';
  /** How long to keep the pickup, in a sentence. */
  hold: string;
  /** Set for a stream that drops a better, widely rostered player who may not come back. */
  keepWarning?: string;
  /** The pickup's days left: whether he plays, and whether that game makes your lineup. */
  addDays: MoveDay[];
  /** The dropped player's games you give up (ones he'd have started). */
  dropDays: MoveDay[];
}

/** One day of a move's strip: game = his team plays and he's on your roster; counts = he starts. */
export interface MoveDay { date: string; game: boolean; counts: boolean }

/** The matchup's projected final score: points so far plus the best lineups for the days left. */
export interface MatchupProjection {
  opponentName: string;
  me: { now: number; projected: number; withMoves: number };
  opponent: { now: number; projected: number };
}

/** What the core list costs: moves the engine would make if it could drop these core players. */
export interface CoreCost {
  /** Extra points this week over the moves allowed now. */
  gain: number;
  players: { id: number; name: string; addName: string; pointsGain: number }[];
}

export interface WatchlistNote {
  player: StreamPlayer & { onWaivers: boolean };
  /** The best swap for this player, if it adds anything. */
  bestMove?: StreamMove;
  rostered: boolean;
}

export interface StreamingPlan {
  week: number;
  daysLeft: number;
  addsLeft: number | null;
  pointsLeague: boolean;
  /** Started points and usable games left this week with the current roster. */
  baseline: { points: number; usableGames: number };
  /** After the suggested moves. */
  after: { points: number; usableGames: number };
  moves: StreamMove[];
  core: number[];
  /** true when the user hasn't picked core players and we assumed their best starters. */
  coreIsDefault: boolean;
  droppable: StreamPlayer[];
  watchlist: WatchlistNote[];
  /** Every free agent with games left, ranked by what he'd add in your best swap this week. */
  freeAgents: FreeAgentNote[];
  /** Days the suggested pickups fill empty spots. */
  fillsDays: string[];
  matchup?: MatchupProjection;
  coreCost?: CoreCost;
  /** Things that block or change your moves (an IR player who's no longer out, no pickups left). */
  warnings: string[];
  /** Near the week's end: pickups who play the last days and early next week. */
  bridge?: BridgePlan;
}

/**
 * Pickups for the turn of the week: free agents who play on the week's last game days and again in
 * the first days of next week, so one add covers both (and next week's pickups start fresh).
 */
export interface BridgePlan {
  /** The days shown: this week's game days left, then next week's first days. */
  days: { date: string; next: boolean }[];
  picks: BridgePickup[];
}

export interface BridgePickup {
  player: StreamPlayer & { percentOwned?: number };
  drop: string;
  /** Lineup points he adds over this week's days left and next week's first days. */
  pointsGain: number;
  thisWeek: number;
  early: number;
  /** One per shown day: his team plays, and whether that game makes your lineup. */
  days: { game: boolean; counts: boolean }[];
}

export interface FreeAgentNote {
  player: StreamPlayer & { onWaivers: boolean; percentOwned?: number };
  /** Points his best swap adds this week (0 if none helps). */
  pointsGain: number;
  dropFor?: string;
}

interface Candidate {
  player: Player;
  value: number;
  /** First scoring period this player can count (pickups on waivers start later). */
  from: number;
  /** For a player being dropped later in the week: he counts on days before this one. */
  until?: number;
  /** Days between making a pickup and the player counting (waiver claims). */
  delay?: number;
  /** Extra points per game while teammates are out (points leagues). */
  boosts?: TeammateBoost[];
  /** The injury report's return date, when he's on it (availability.ts). */
  returnDate?: string;
}

/** What a candidate's game on this date is worth, with any teammate boost still running. */
const valueOn = (c: Candidate, date: string) => c.value + boostOn(c.boosts, date);

/**
 * Expected fantasy points per game: minutes times points per minute. Minutes are the first thing
 * to move with a new role (a crowded rotation, a starter's injury), so this season's minutes take
 * over within a few games; points per minute is noisier and leans on the projection longer.
 */
export function expectedFppg(p: Player): number {
  const s = p.stats;
  if (!s) return 0;
  const season = s.seasonAvg ?? 0;
  const gp = s.gamesPlayed ?? 0;
  const proj = s.projectedAvg ?? season;
  if (gp <= 0 || !season) return proj;
  if (s.seasonMin && s.projectedMin && proj) {
    // Preseason projections can overrate a player per minute (Day'Ron Sharpe: 1.23 projected,
    // 0.88 real), so real games take over by about game 3.
    const perMin = blend(season / s.seasonMin, proj / s.projectedMin, gp / (gp + 3));
    return expectedMinutes(p) * perMin;
  }
  const recent = s.last15Avg || season;
  const played = 0.5 * recent + 0.5 * season;
  const w = Math.min(1, gp / 10); // lean on the projection until about 10 games in
  return w * played + (1 - w) * proj;
}

const blend = (actual: number, projected: number, w: number) => w * actual + (1 - w) * projected;

/** Share of the minutes projection that rests on this season's games. */
const minutesWeight = (p: Player) => {
  const gp = p.stats?.gamesPlayed ?? 0;
  return p.stats?.seasonMin && gp > 0 ? gp / (gp + 1.5) : 0;
};

/** Expected minutes per game: this season's minutes take over from the projection within a few games. */
export function expectedMinutes(p: Player): number {
  const s = p.stats;
  if (!s) return 0;
  if (!s.projectedMin) return s.seasonMin ?? 0;
  return blend(s.seasonMin ?? 0, s.projectedMin, minutesWeight(p));
}

const isPointsLeague = (snapshot: LeagueSnapshot) => (snapshot.scoringType ?? '').includes('POINTS');

/**
 * What a game from this player is worth: expected fantasy points in points leagues. Categories
 * leagues have no points to add up, so every game counts the same (ties go to the more widely
 * rostered player).
 */
export function playerValue(snapshot: LeagueSnapshot, p: Player): number {
  return isPointsLeague(snapshot) ? expectedFppg(p) : 1 + (p.ownership?.percentOwned ?? 0) / 1000;
}

/** Starting lineup spots by ESPN slot id (bench and IR left out). */
export function startingSlots(snapshot: LeagueSnapshot): number[] {
  return Object.entries(snapshot.lineupSlots ?? {}).flatMap(([slot, n]) =>
    Number(slot) === BENCH_SLOT || Number(slot) === IR_SLOT ? [] : Array<number>(n).fill(Number(slot))
  );
}

/** The best lineup for one day's games: which players start, and their total value. */
export function bestLineup(players: Player[], slots: number[], value: (p: Player) => number): { total: number; started: Set<number> } {
  return fillDay(players.map((p) => ({ player: p, value: value(p), from: 0 })), slots, (c) => c.value);
}

/** Chance a player with this status plays today's game. */
export const playChanceToday = (status: PlayerStatus) => PLAY_CHANCE[status] ?? 1;

/**
 * Fill one day's lineup: highest value first, each into a slot it's eligible for, moving earlier
 * players between slots when that frees a spot (augmenting paths). With weights on players only,
 * this greedy matching is optimal.
 */
function fillDay(players: Candidate[], slots: number[], values: (c: Candidate) => number): { total: number; started: Set<number> } {
  const owner: (number | null)[] = slots.map(() => null);
  const byId = new Map(players.map((c) => [c.player.id, c]));
  const canUse = (c: Candidate, i: number) => c.player.eligibleSlots.includes(slots[i]);

  function place(id: number, seen: Set<number>): boolean {
    const c = byId.get(id)!;
    for (let i = 0; i < slots.length; i++) {
      if (seen.has(i) || !canUse(c, i)) continue;
      seen.add(i);
      if (owner[i] === null || place(owner[i]!, seen)) {
        owner[i] = id;
        return true;
      }
    }
    return false;
  }

  const started = new Set<number>();
  let total = 0;
  for (const c of [...players].sort((a, b) => values(b) - values(a))) {
    if (values(c) <= 0) continue;
    if (place(c.player.id, new Set())) {
      started.add(c.player.id);
      total += values(c);
    }
  }
  return { total, started };
}

interface WeekResult {
  points: number;
  usableGames: number;
  usableById: Map<number, number>;
  /** Who starts each day (by scoring period). */
  startedByDay: Map<number, Set<number>>;
}

function simulateWeek(roster: Candidate[], week: MatchupWeekSchedule, today: number, slots: number[], asOf: string): WeekResult {
  let points = 0;
  let usableGames = 0;
  const usableById = new Map<number, number>();
  const startedByDay = new Map<number, Set<number>>();
  for (const day of week.days) {
    if (day.scoringPeriodId < today) continue;
    const playing = roster.filter(
      (c) =>
        day.scoringPeriodId >= c.from &&
        (c.until === undefined || day.scoringPeriodId < c.until) &&
        (week.teamGames[c.player.nbaTeamId] ?? []).includes(day.scoringPeriodId)
    );
    const ahead = daysBetween(asOf, day.date);
    const { total, started } = fillDay(playing, slots, (c) => valueOn(c, day.date) * chanceOn(c.player.status, c.returnDate, day.date, ahead));
    points += total;
    usableGames += started.size;
    for (const id of started) usableById.set(id, (usableById.get(id) ?? 0) + 1);
    startedByDay.set(day.scoringPeriodId, started);
  }
  return { points, usableGames, usableById, startedByDay };
}

function gamesLeft(p: Player, week: MatchupWeekSchedule, from: number): number {
  return (week.teamGames[p.nbaTeamId] ?? []).filter((d) => d >= from).length;
}

const dateLabel = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const names = (bs: TeammateBoost[]) => bs.map((b) => b.out.name).join(' and ');
const isAre = (bs: TeammateBoost[]) => (bs.length === 1 ? 'is' : 'are');

/** "+6 min with Stephen Curry out (back about Oct 29)", for the boosts still running on asOf. */
function opportunityNote(boosts: TeammateBoost[] | undefined, asOf: string): string | undefined {
  const live = (boosts ?? []).filter((b) => asOf < b.until);
  const minutes = Math.round(live.reduce((sum, b) => sum + b.minutes, 0));
  if (minutes < 1) return undefined;
  const dated = live.filter((b) => b.dated).map((b) => b.until).sort();
  const back = dated.length === live.length ? ` (back about ${dateLabel(dated[0])})` : '';
  return `+${minutes} min with ${names(live)} out${back}`;
}

function describe(c: Candidate, week: MatchupWeekSchedule, today: number, usable: number, asOf: string, from = today, next?: MatchupWeekSchedule): StreamPlayer {
  const p = c.player;
  const value = valueOn(c, asOf);
  return {
    id: p.id,
    name: p.name,
    nbaTeamAbbrev: p.nbaTeamAbbrev,
    positions: p.positions,
    status: p.status,
    fppg: Math.round(value * 10) / 10,
    gamesLeft: gamesLeft(p, week, Math.max(today, from)),
    usableLeft: usable,
    gamesNext: next ? (next.teamGames[p.nbaTeamId] ?? []).length : undefined,
    opportunity: opportunityNote(c.boosts, asOf),
  };
}

export function buildStreamingPlan(snapshot: LeagueSnapshot, core: number[], watchIds: number[] = []): StreamingPlan | null {
  const week = snapshot.matchupWeek;
  const next = snapshot.nextMatchupWeek;
  const me = snapshot.teams.find((t) => t.id === snapshot.myTeamId);
  if (!week || !me?.roster) return null;
  const today = currentPeriod(snapshot);
  const asOf = easternDate(snapshot.fetchedAt);

  const slots = startingSlots(snapshot);
  if (!slots.length) return null;

  const pointsLeague = isPointsLeague(snapshot);
  const valueOf = (p: Player) => playerValue(snapshot, p);
  // Categories leagues count every game the same, so extra minutes don't change a game's value there.
  const boosts = pointsLeague ? teammateBoosts(snapshot, asOf, { fppg: expectedFppg, minutes: expectedMinutes, minutesWeight }) : new Map<number, TeammateBoost[]>();

  const returnOf = (id: number) => snapshot.injuries?.[id]?.returnDate;
  const roster: Candidate[] = me.roster
    .filter((e) => e.lineupSlotId !== IR_SLOT)
    .map((e) => ({ player: e.player, value: valueOf(e.player), from: today, boosts: boosts.get(e.player.id), returnDate: returnOf(e.player.id) }));

  const coreIsDefault = core.length === 0;
  const coreIds = new Set(
    coreIsDefault ? [...roster].sort((a, b) => b.value - a.value).slice(0, slots.length).map((c) => c.player.id) : core
  );
  const droppable = roster.filter((c) => !coreIds.has(c.player.id));

  const pool = new Map<number, FreeAgentEntry>(snapshot.freeAgentsTopN.map((fa) => [fa.player.id, fa]));
  const toCandidate = (fa: FreeAgentEntry): Candidate => ({
    player: fa.player,
    value: valueOf(fa.player),
    from: today + (fa.onWaivers ? WAIVER_DELAY_DAYS : 0),
    delay: fa.onWaivers ? WAIVER_DELAY_DAYS : 0,
    boosts: boosts.get(fa.player.id),
    returnDate: returnOf(fa.player.id),
  });
  // Someone out who's back before the week ends still counts for the games after his return.
  const freeAgents = [...pool.values()]
    .map(toCandidate)
    .filter((c) => week.days.some((d) => d.scoringPeriodId >= Math.max(today, c.from) && (week.teamGames[c.player.nbaTeamId] ?? []).includes(d.scoringPeriodId) && chanceOn(c.player.status, c.returnDate, d.date, daysBetween(asOf, d.date)) > 0));

  const baseline = simulateWeek(roster, week, today, slots, asOf);
  const minGain = pointsLeague ? MIN_POINTS_GAIN : 1;
  const limit = snapshot.acquisitions?.limit ?? null;
  const addsLeft = limit === null ? null : Math.max(0, limit - (snapshot.acquisitions?.used ?? 0));

  const lastDay = week.days[week.days.length - 1]?.scoringPeriodId ?? today;
  /** Days a swap could happen: now, or the day after each of the dropped player's games. */
  const swapDays = (drop: Candidate) => [
    today,
    ...(week.teamGames[drop.player.nbaTeamId] ?? []).filter((d) => d >= today && d < lastDay).map((d) => d + 1),
  ];

  /**
   * The best add/drop and when to make it. Waiting lets the dropped player use his games first
   * (say he plays the opener and the pickup doesn't need that day). Waiting only wins if it adds
   * at least a point, so the default is to move now.
   */
  function bestSwap(current: Candidate[], drops: Candidate[], adds: Candidate[]) {
    const before = simulateWeek(current, week!, today, slots, asOf);
    type Swap = { drop: Candidate; add: Candidate; swapDay: number; roster: Candidate[]; result: WeekResult; gain: number };
    let best: Swap | null = null;
    for (const drop of drops) {
      const rest = current.filter((c) => c.player.id !== drop.player.id);
      const days = [...new Set(swapDays(drop))].sort((a, b) => a - b);
      for (const add of adds) {
        let pick: Swap | null = null;
        for (const day of days) {
          const timedAdd = day === today ? add : { ...add, from: Math.max(add.from, day + (add.delay ?? 0)) };
          const roster = day === today ? [...rest, timedAdd] : [...rest, { ...drop, until: day }, timedAdd];
          const result = simulateWeek(roster, week!, today, slots, asOf);
          const gain = result.points - before.points;
          if (!pick || gain > pick.gain + 1) pick = { drop, add: timedAdd, swapDay: day, roster, result, gain };
        }
        if (pick && (!best || pick.gain > best.gain)) best = pick;
      }
    }
    return best ? { ...best, before, current } : null;
  }

  function toMove(s: NonNullable<ReturnType<typeof bestSwap>>): StreamMove {
    const fa = pool.get(s.add.player.id);
    const usableGamesGain = s.result.usableGames - s.before.usableGames;
    const add = describe(s.add, week!, today, s.result.usableById.get(s.add.player.id) ?? 0, asOf, s.add.from, next);
    const drop = describe(s.drop, week!, today, s.before.usableById.get(s.drop.player.id) ?? 0, asOf, today, next);
    const extra = usableGamesGain > 0 ? `+${usableGamesGain} usable game${usableGamesGain === 1 ? '' : 's'}. ` : '';
    const minutes = add.opportunity ? ` ${add.name}: ${add.opportunity}.` : '';
    let reason = `${extra}${add.name} starts ${add.usableLeft} of his ${add.gamesLeft} games left; ${drop.name} starts ${drop.usableLeft} of ${drop.gamesLeft}.${minutes}`;
    // Waiting: the dropped player keeps the games before the swap.
    let swapAfter: StreamMove['swapAfter'];
    if (s.swapDay > today) {
      const date = week!.days.find((d) => d.scoringPeriodId === s.swapDay - 1)?.date ?? '';
      const label = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
      const kept = s.result.usableById.get(s.drop.player.id) ?? 0;
      swapAfter = { date, label };
      reason =
        `Wait: keep ${drop.name} through ${label} (${kept} game${kept === 1 ? '' : 's'} he starts), then make this move after that day's games. ` +
        `${extra}${add.name} starts ${add.usableLeft} of his ${add.gamesLeft} games after that.${minutes}`;
    }
    let nextWeek: StreamMove['nextWeek'];
    let nextWeekWarning: string | undefined;
    if (next) {
      // Next week with the swap kept, against next week without it.
      const firstNext = next.days[0]?.scoringPeriodId ?? today;
      const kept = simulateWeek([...s.current.filter((c) => c.player.id !== s.drop.player.id), s.add], next, firstNext, slots, asOf).points;
      // (a dropped player waiting out the week is gone by next week either way)
      const without = simulateWeek(s.current, next, firstNext, slots, asOf).points;
      nextWeek = { pointsChange: Math.round(kept - without), addGames: add.gamesNext ?? 0, dropGames: drop.gamesNext ?? 0 };
      if (nextWeek.pointsChange <= -minGain) {
        nextWeekWarning = `Heads up: next week ${drop.name} plays ${nextWeek.dropGames} games and ${add.name} ${nextWeek.addGames}, so this swap costs about ${-nextWeek.pointsChange} projected pts next week.`;
      }
    }
    // Points leagues only: in categories every game is worth the same, so there's no "better player" here.
    // Long absences (weeks) count toward keeping a player; a teammate out a game or two doesn't.
    const held = (c: Candidate) => c.value + longBoost(c.boosts, asOf);
    const kind: StreamMove['kind'] =
      !pointsLeague || s.add.value >= s.drop.value - 0.5 ? 'upgrade' : held(s.add) >= held(s.drop) - 0.5 ? 'opportunity' : 'stream';
    const long = (s.add.boosts ?? []).filter((b) => longBoost([b], asOf) > 0);
    const short = (s.add.boosts ?? []).filter((b) => asOf < b.until && !long.includes(b));
    const hold =
      kind === 'upgrade'
        ? `Keep him: as good per game as ${drop.name}.`
        : kind === 'opportunity'
          ? `Keep him while ${names(long)} ${isAre(long)} out (back about ${dateLabel(long.map((b) => b.until).sort()[0])}), then look again.`
          : short.length
            ? `Short-term: worth it while ${names(short)} ${isAre(short)} out.`
            : `Short-term: for this week's games.`;
    const owned = s.drop.player.ownership?.percentOwned ?? 0;
    const keepWarning =
      kind === 'stream' && owned >= LIKELY_CLAIMED_PCT
        ? `${drop.name} is the better player per game (${drop.fppg} vs ${add.fppg}) and ${Math.round(owned)}% of leagues roster him, so he may get claimed.`
        : undefined;
    const left = week!.days.filter((d) => d.scoringPeriodId >= today && Object.values(week!.teamGames).some((g) => g.includes(d.scoringPeriodId)));
    const plays = (c: Candidate, period: number) => (week!.teamGames[c.player.nbaTeamId] ?? []).includes(period);
    const addDays = left.map((d) => ({
      date: d.date,
      game: plays(s.add, d.scoringPeriodId) && d.scoringPeriodId >= s.add.from,
      counts: !!s.result.startedByDay.get(d.scoringPeriodId)?.has(s.add.player.id),
    }));
    // Lost: games he'd have started, from the day he's gone.
    const dropDays = left.map((d) => {
      const gone = d.scoringPeriodId >= s.swapDay;
      return { date: d.date, game: gone && plays(s.drop, d.scoringPeriodId), counts: gone && !!s.before.startedByDay.get(d.scoringPeriodId)?.has(s.drop.player.id) };
    });
    return {
      addDays,
      dropDays,
      kind,
      hold,
      keepWarning,
      drop,
      add: { ...add, onWaivers: !!fa?.onWaivers, percentOwned: fa?.player.ownership?.percentOwned },
      pointsGain: Math.round(s.gain * 10) / 10,
      usableGamesGain,
      reason,
      swapAfter,
      nextWeek,
      nextWeekWarning,
    };
  }

  // Take the best swap, apply it, look again, until pickups run out or nothing helps enough.
  const maxMoves = addsLeft ?? MAX_MOVES;
  function searchMoves(dropPool: Candidate[]) {
    const found: StreamMove[] = [];
    let current = roster;
    let drops = dropPool;
    let adds = freeAgents;
    while (found.length < maxMoves) {
      const s = bestSwap(current, drops, adds);
      if (!s || s.gain < minGain) break;
      found.push(toMove(s));
      current = s.roster;
      drops = drops.filter((c) => c.player.id !== s.drop.player.id);
      adds = adds.filter((c) => c.player.id !== s.add.player.id);
    }
    return { moves: found, after: simulateWeek(current, week!, today, slots, asOf) };
  }
  const { moves, after } = searchMoves(droppable);

  // What the core list costs: the same search allowed to drop anyone outside the best starters.
  let coreCost: CoreCost | undefined;
  if (!coreIsDefault && maxMoves > 0) {
    const starters = new Set([...roster].sort((a, b) => b.value - a.value).slice(0, slots.length).map((c) => c.player.id));
    const wider = roster.filter((c) => !starters.has(c.player.id));
    if (wider.some((c) => coreIds.has(c.player.id))) {
      const open = searchMoves(wider);
      const gain = Math.round(open.after.points - after.points);
      const unlock = open.moves.filter((m) => coreIds.has(m.drop.id));
      if (gain >= minGain && unlock.length) {
        coreCost = { gain, players: unlock.map((m) => ({ id: m.drop.id, name: m.drop.name, addName: m.add.name, pointsGain: Math.round(m.pointsGain) })) };
      }
    }
  }

  // The matchup's projected final: points so far plus each side's best lineups for the days left.
  let matchup: MatchupProjection | undefined;
  const game = snapshot.matchups.find((m) => m.isMyMatchup && m.week === snapshot.week);
  const oppId = game && (game.homeTeamId === me.id ? game.awayTeamId : game.homeTeamId);
  const opp = snapshot.teams.find((t) => t.id === oppId);
  if (game && opp?.roster && pointsLeague) {
    const mine = game.homeTeamId === me.id ? game.homePoints : game.awayPoints ?? 0;
    const theirs = game.homeTeamId === me.id ? game.awayPoints ?? 0 : game.homePoints;
    const oppRoster: Candidate[] = opp.roster
      .filter((e) => e.lineupSlotId !== IR_SLOT)
      .map((e) => ({ player: e.player, value: valueOf(e.player), from: today, boosts: boosts.get(e.player.id), returnDate: returnOf(e.player.id) }));
    const oppLeft = simulateWeek(oppRoster, week, today, slots, asOf).points;
    matchup = {
      opponentName: opp.name,
      me: { now: Math.round(mine), projected: Math.round(mine + baseline.points), withMoves: Math.round(mine + after.points) },
      opponent: { now: Math.round(theirs), projected: Math.round(theirs + oppLeft) },
    };
  }

  // Days the moves put someone in an empty spot.
  const gameDays = week.days.filter((d) => d.scoringPeriodId >= today && Object.values(week.teamGames).some((g) => g.includes(d.scoringPeriodId)));
  const fillsDays = gameDays
    .filter((d) => (after.startedByDay.get(d.scoringPeriodId)?.size ?? 0) > (baseline.startedByDay.get(d.scoringPeriodId)?.size ?? 0))
    .map((d) => d.date);

  // Things that block moves. ESPN only lets "out" players sit on IR; once one isn't, it blocks adds
  // until he's moved off (which takes a roster spot).
  const warnings: string[] = [];
  for (const e of me.roster.filter((e) => e.lineupSlotId === IR_SLOT)) {
    const back = returnOf(e.player.id);
    const name = e.player.name;
    if (!['OUT', 'INJURY_RESERVE', 'SUSPENSION'].includes(e.player.status)) {
      warnings.push(`${name} is on IR but no longer listed out, so ESPN blocks your adds until he's moved off IR. That needs a roster spot: plan who to drop.`);
    } else if (back && back <= (week.days[week.days.length - 1]?.date ?? '')) {
      warnings.push(`${name} is due back around ${dateLabel(back)}. When he comes off IR you'll need a roster spot, and ESPN blocks adds until you make one.`);
    }
  }
  if (addsLeft === 0) warnings.push('No pickups left this week: moves start again next week.');

  // Watchlist: where each watched player stands, and his best swap on the current roster.
  const rosterIds = new Set(roster.map((c) => c.player.id));
  const watchlist: WatchlistNote[] = [];
  for (const id of watchIds) {
    const fa = pool.get(id);
    if (rosterIds.has(id)) {
      const c = roster.find((r) => r.player.id === id)!;
      watchlist.push({ player: { ...describe(c, week, today, baseline.usableById.get(id) ?? 0, asOf, today, next), onWaivers: false }, rostered: true });
    } else if (fa) {
      const c = toCandidate(fa);
      const s = bestSwap(roster, droppable, [c]);
      watchlist.push({
        player: { ...describe(c, week, today, s?.result.usableById.get(id) ?? 0, asOf, c.from, next), onWaivers: !!fa.onWaivers },
        bestMove: s && s.gain > 0 ? toMove(s) : undefined,
        rostered: false,
      });
    }
  }

  const faNotes: FreeAgentNote[] = freeAgents.map((c) => {
    const s = bestSwap(roster, droppable, [c]);
    const fa = pool.get(c.player.id);
    return {
      player: {
        ...describe(c, week, today, s?.result.usableById.get(c.player.id) ?? 0, asOf, c.from, next),
        onWaivers: !!fa?.onWaivers,
        percentOwned: fa?.player.ownership?.percentOwned,
      },
      pointsGain: s && s.gain > 0 ? Math.round(s.gain * 10) / 10 : 0,
      dropFor: s && s.gain > 0 ? s.drop.player.name : undefined,
    };
  });
  faNotes.sort((a, b) => b.pointsGain - a.pointsGain || b.player.fppg * b.player.gamesLeft - a.player.fppg * a.player.gamesLeft);

  // Turn of the week: who plays the last days and early next week. Free agents only (a waiver
  // claim misses the last days), each with his best drop over both stretches.
  let bridge: BridgePlan | undefined;
  const firstNext = next?.days[0]?.scoringPeriodId;
  if (next && firstNext !== undefined && gameDays.length > 0 && gameDays.length <= BRIDGE_DAYS_LEFT) {
    const early: MatchupWeekSchedule = { days: next.days.slice(0, BRIDGE_NEXT_DAYS), teamGames: next.teamGames };
    const plays = (c: Candidate, s: MatchupWeekSchedule, period: number) => (s.teamGames[c.player.nbaTeamId] ?? []).includes(period);
    const baseEarly = simulateWeek(roster, early, firstNext, slots, asOf);
    const picks: BridgePickup[] = [];
    for (const add of freeAgents) {
      if (add.delay || !early.days.some((d) => plays(add, early, d.scoringPeriodId))) continue;
      let best: { drop: Candidate; thisWeek: WeekResult; earlyWeek: WeekResult; gain: number; a: number; b: number } | null = null;
      for (const drop of droppable) {
        const swapped = [...roster.filter((c) => c.player.id !== drop.player.id), add];
        const thisWeek = simulateWeek(swapped, week, today, slots, asOf);
        const earlyWeek = simulateWeek(swapped, early, firstNext, slots, asOf);
        const a = thisWeek.points - baseline.points;
        const b = earlyWeek.points - baseEarly.points;
        if (!best || a + b > best.gain) best = { drop, thisWeek, earlyWeek, gain: a + b, a, b };
      }
      // He has to help on both sides of the week line. And this week's part has to be real: if
      // the player you'd drop plays the last days too, keeping him and swapping after the week
      // gets next week's games just as well.
      if (!best || best.a < minGain || !(best.thisWeek.usableById.get(add.player.id) ?? 0) || !(best.earlyWeek.usableById.get(add.player.id) ?? 0)) continue;
      const fa = pool.get(add.player.id);
      picks.push({
        player: { ...describe(add, week, today, best.thisWeek.usableById.get(add.player.id) ?? 0, asOf, today, next), percentOwned: fa?.player.ownership?.percentOwned },
        drop: best.drop.player.name,
        pointsGain: Math.round(best.gain),
        thisWeek: Math.round(best.a),
        early: Math.round(best.b),
        days: [
          ...gameDays.map((d) => ({ game: plays(add, week, d.scoringPeriodId), counts: !!best!.thisWeek.startedByDay.get(d.scoringPeriodId)?.has(add.player.id) })),
          ...early.days.map((d) => ({ game: plays(add, early, d.scoringPeriodId), counts: !!best!.earlyWeek.startedByDay.get(d.scoringPeriodId)?.has(add.player.id) })),
        ],
      });
    }
    picks.sort((x, y) => y.pointsGain - x.pointsGain);
    bridge = {
      days: [...gameDays.map((d) => ({ date: d.date, next: false })), ...early.days.map((d) => ({ date: d.date, next: true }))],
      picks: picks.slice(0, BRIDGE_PICKS),
    };
  }

  // Worth-a-move players first, biggest gain on top; rostered ones last.
  const rank = (w: WatchlistNote) => (w.rostered ? -2 : w.bestMove ? w.bestMove.pointsGain : -1);
  watchlist.sort((a, b) => rank(b) - rank(a));

  const round = (r: WeekResult) => ({ points: Math.round(r.points), usableGames: r.usableGames });
  return {
    week: snapshot.week,
    daysLeft: week.days.filter((d) => d.scoringPeriodId >= today).length,
    addsLeft,
    pointsLeague,
    baseline: round(baseline),
    after: round(after),
    moves,
    core: [...coreIds],
    coreIsDefault,
    droppable: droppable.map((c) => describe(c, week, today, baseline.usableById.get(c.player.id) ?? 0, asOf, today, next)),
    watchlist,
    freeAgents: faNotes.slice(0, 40),
    fillsDays,
    matchup,
    coreCost,
    warnings,
    bridge,
  };
}
