/**
 * Matchup games
 * How many games each player plays in the current matchup week, for both sides of the matchup.
 */

import { NBA_TEAMS } from './espnClient';
import type {
  LeagueSnapshot,
  MatchupGamesComparison,
  MatchupSideGames,
  MatchupWeekSchedule,
  Team,
} from '@/types';
import { chanceOn, LIKELY } from './availability';

const BENCH_SLOT = 12;
const IR_SLOT = 13;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Calendar date (YYYY-MM-DD) of a game in US Eastern time, which is how ESPN splits days. */
function easternDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

type ProTeamSchedule = Array<{ id: number; proGamesByScoringPeriod?: Record<string, Array<{ date: number }>> }>;

/** The calendar date of each scoring period, anchored on any game in the schedule. */
function periodDates(nbaSchedule: ProTeamSchedule): ((period: number) => string) | undefined {
  for (const team of nbaSchedule) {
    for (const [period, games] of Object.entries(team.proGamesByScoringPeriod ?? {})) {
      if (games[0]) {
        const anchorMs = Date.parse(`${easternDate(games[0].date)}T12:00:00Z`);
        const anchorPeriod = Number(period);
        return (p: number) => new Date(anchorMs + (p - anchorPeriod) * DAY_MS).toISOString().slice(0, 10);
      }
    }
  }
  return undefined;
}

function scheduleFor(nbaSchedule: ProTeamSchedule, periods: number[], dateOf: (p: number) => string): MatchupWeekSchedule {
  const inWeek = new Set(periods);
  const teamGames: Record<number, number[]> = {};
  for (const team of nbaSchedule) {
    teamGames[team.id] = Object.entries(team.proGamesByScoringPeriod ?? {})
      .filter(([period, games]) => games.length > 0 && inWeek.has(Number(period)))
      .map(([period]) => Number(period))
      .sort((a, b) => a - b);
  }
  return { days: periods.map((p) => ({ scoringPeriodId: p, date: dateOf(p) })), teamGames };
}

/**
 * Days of the current matchup week and which of them each NBA team plays.
 * Uses the league's matchup period mapping. Before the season ESPN maps every matchup period to a
 * single day, so in that case the week runs from today through Sunday (ESPN weeks end on Sunday).
 */
export function buildMatchupWeek(
  nbaSchedule: ProTeamSchedule,
  matchupPeriods: Record<string, number[]> | undefined,
  currentMatchupPeriod: number,
  currentScoringPeriod: number
): MatchupWeekSchedule | undefined {
  const dateOf = periodDates(nbaSchedule);
  if (!dateOf) return undefined;
  let periods = matchupPeriods?.[String(currentMatchupPeriod)] ?? [];
  if (periods.length <= 1) {
    const dow = new Date(`${dateOf(currentScoringPeriod)}T12:00:00Z`).getUTCDay(); // 0 = Sunday
    const daysToSunday = (7 - dow) % 7;
    periods = Array.from({ length: daysToSunday + 1 }, (_, i) => currentScoringPeriod + i);
  }
  return scheduleFor(nbaSchedule, periods, dateOf);
}

/**
 * The matchup week after this one: the league's next matchup period, or (when ESPN hasn't mapped
 * it to real days yet, as before the season) the Monday-to-Sunday week after this one ends.
 */
export function buildNextMatchupWeek(
  nbaSchedule: ProTeamSchedule,
  matchupPeriods: Record<string, number[]> | undefined,
  currentMatchupPeriod: number,
  thisWeek: MatchupWeekSchedule | undefined
): MatchupWeekSchedule | undefined {
  const dateOf = periodDates(nbaSchedule);
  const last = thisWeek?.days[thisWeek.days.length - 1]?.scoringPeriodId;
  if (!dateOf || last === undefined) return undefined;
  let periods = matchupPeriods?.[String(currentMatchupPeriod + 1)] ?? [];
  if (periods.length <= 1 || periods[0] <= last) periods = Array.from({ length: 7 }, (_, i) => last + 1 + i);
  return scheduleFor(nbaSchedule, periods, dateOf);
}

/**
 * Today's scoring period. ESPN keeps the last game day as "current" until the next one starts, so
 * on a day with no games (or before ESPN rolls over) its period is already over: the first day of
 * the week dated today or later counts as today instead.
 */
export function currentPeriod(snapshot: Pick<LeagueSnapshot, 'scoringPeriodId' | 'matchupWeek' | 'fetchedAt' | 'dayDone'>): number {
  const asOf = easternDate(snapshot.fetchedAt);
  // Once every game today is final, today is over too: its points are already in the score.
  const next = snapshot.matchupWeek?.days.find((d) => d.scoringPeriodId >= snapshot.scoringPeriodId && d.date >= asOf && d.date !== snapshot.dayDone);
  if (next) return next.scoringPeriodId;
  const last = snapshot.matchupWeek?.days.at(-1);
  return last && last.date === snapshot.dayDone ? last.scoringPeriodId + 1 : snapshot.scoringPeriodId;
}

/** Starting lineup spots: every slot except bench and IR. */
export function countStartingSlots(lineupSlotCounts: Record<string, number> | undefined): number {
  return Object.entries(lineupSlotCounts ?? {})
    .filter(([slot]) => Number(slot) !== BENCH_SLOT && Number(slot) !== IR_SLOT)
    .reduce((sum, [, n]) => sum + n, 0);
}

/** Starting lineup spots by ESPN slot id, one entry per spot (bench and IR left out). */
function slotList(lineupSlotCounts: Record<string, number> | undefined): number[] {
  return Object.entries(lineupSlotCounts ?? {}).flatMap(([slot, n]) =>
    Number(slot) === BENCH_SLOT || Number(slot) === IR_SLOT ? [] : Array<number>(n).fill(Number(slot)));
}

/**
 * How many of a day's players can start at once: each needs a slot he's eligible for (four
 * centers can't all start in a lineup with one C spot and three UTIL). Maximum matching with
 * augmenting paths; without slot data, the plain lineup size caps it.
 */
function maxStarters(eligible: number[][], slots: number[], cap: number): number {
  if (!slots.length) return Math.min(eligible.length, cap || eligible.length);
  const owner: (number | null)[] = slots.map(() => null);
  const place = (i: number, seen: Set<number>): boolean => {
    for (let s = 0; s < slots.length; s++) {
      if (seen.has(s) || !eligible[i].includes(slots[s])) continue;
      seen.add(s);
      if (owner[s] === null || place(owner[s]!, seen)) { owner[s] = i; return true; }
    }
    return false;
  };
  let n = 0;
  for (let i = 0; i < eligible.length; i++) if (place(i, new Set())) n++;
  return n;
}

/**
 * A game counts when he's likely to play it (availability.ts): out until his return date even if
 * ESPN calls him day-to-day, back from it even if he's on IR now. Past days count what was scheduled.
 */
function sideGames(team: Team, week: MatchupWeekSchedule, today: number, slots: number, lineup: number[], injuries: LeagueSnapshot['injuries'], asOf: string): MatchupSideGames {
  const todayDate = week.days.find((d) => d.scoringPeriodId === today)?.date ?? asOf;
  const players = (team.roster ?? []).map((entry) => {
    const p = entry.player;
    const played = new Set(week.teamGames[p.nbaTeamId] ?? []);
    const returnDate = injuries?.[p.id]?.returnDate;
    const playsByDay = week.days.map((d) => played.has(d.scoringPeriodId) &&
      (d.scoringPeriodId < today || chanceOn(p.status, returnDate, d.date, Math.round((Date.parse(d.date) - Date.parse(todayDate)) / DAY_MS)) >= LIKELY));
    return {
      playerId: p.id,
      name: p.name,
      nbaTeamAbbrev: p.nbaTeamAbbrev,
      status: p.status,
      injured: !playsByDay.some((x, i) => x && week.days[i].scoringPeriodId >= today) && (entry.lineupSlotId === IR_SLOT || p.status === 'OUT' || p.status === 'INJURY_RESERVE'),
      games: playsByDay.filter(Boolean).length,
      gamesLeft: week.days.filter((d, i) => playsByDay[i] && d.scoringPeriodId >= today).length,
      playsByDay,
    };
  });
  players.sort((a, b) => b.games - a.games || a.name.localeCompare(b.name));

  const healthy = players.filter((p) => !p.injured);
  const playingByDay = week.days.map((_, i) => healthy.filter((p) => p.playsByDay[i]).length);
  const slotsOf = new Map((team.roster ?? []).map((e) => [e.player.id, e.player.eligibleSlots ?? []]));
  const startableByDay = week.days.map((_, i) => maxStarters(healthy.filter((p) => p.playsByDay[i]).map((p) => slotsOf.get(p.playerId) ?? []), lineup, slots));
  return {
    teamId: team.id,
    name: team.name,
    players,
    playingByDay,
    startableByDay,
    totalGames: healthy.reduce((sum, p) => sum + p.games, 0),
    usableGames: startableByDay.reduce((sum, n) => sum + n, 0),
    gamesLeft: healthy.reduce((sum, p) => sum + p.gamesLeft, 0),
  };
}

/** Games this matchup week for my team and my opponent. */
export function compareMatchupGames(snapshot: LeagueSnapshot): MatchupGamesComparison | undefined {
  const week = snapshot.matchupWeek;
  const me = snapshot.teams.find((t) => t.id === snapshot.myTeamId);
  if (!week || !me) return undefined;

  const matchup = snapshot.matchups.find((m) => m.isMyMatchup && m.week === snapshot.week);
  const opponentId = matchup && (matchup.homeTeamId === me.id ? matchup.awayTeamId : matchup.homeTeamId);
  const opponent = snapshot.teams.find((t) => t.id === opponentId);
  const slots = snapshot.startingSlots ?? 0;
  const lineup = slotList(snapshot.lineupSlots);
  const asOf = easternDate(snapshot.fetchedAt);
  const today = currentPeriod(snapshot);

  return {
    week: snapshot.week,
    days: week.days,
    teamsPlaying: week.days.map((d) => Object.values(week.teamGames).filter((g) => g.includes(d.scoringPeriodId)).length),
    teams: Object.entries(week.teamGames)
      .filter(([id]) => NBA_TEAMS[Number(id)])
      .map(([id, g]) => ({ abbrev: NBA_TEAMS[Number(id)].abbrev, byDay: week.days.map((d) => g.includes(d.scoringPeriodId)), next: snapshot.nextMatchupWeek?.teamGames[Number(id)]?.length })),
    today,
    startingSlots: slots,
    me: sideGames(me, week, today, slots, lineup, snapshot.injuries, asOf),
    opponent: opponent && sideGames(opponent, week, today, slots, lineup, snapshot.injuries, asOf),
  };
}
