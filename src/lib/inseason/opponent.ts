/**
 * The other side of the matchup: their games left, their pickups left, and what those pickups
 * could add if they stream well. Not a guess at what they'll do: it's the same move engine we run
 * for you, pointed at their roster (their best starters held, the rest streamable), with their
 * own pickup count. A 38–37 games edge means little if they have 4 adds left and you have 2.
 */

import type { LeagueSnapshot } from '@/types';
import { buildStreamingPlan, type PlayerOutlook } from './streaming';

export interface OpponentOutlook {
  name: string;
  /** Their pickups left this matchup (null = no limit). */
  addsLeft: number | null;
  /** Usable games left: as their roster stands, and if they make the best moves. */
  games: number;
  gamesWithMoves: number;
  /** Points (points leagues) their best moves would add, and how many moves that takes. */
  pointsGain: number;
  moves: number;
  /** Their best moves, in the engine's order: who they'd add and drop, and what each adds. */
  /** Each of their players: games left, games he starts, points we expect. */
  outlook?: PlayerOutlook[];
  picks?: { addId: number; add: string; addTeam?: string; drop: string; gain: number; after?: string }[];
  /** Projected final: as rosters stand, and if they make the best moves. */
  projected?: number;
  projectedWithMoves?: number;
}

export function opponentOutlook(snapshot: LeagueSnapshot): OpponentOutlook | null {
  const game = snapshot.matchups.find((m) => m.isMyMatchup && m.week === snapshot.week);
  const oppId = game && (game.homeTeamId === snapshot.myTeamId ? game.awayTeamId : game.homeTeamId);
  const opp = snapshot.teams.find((t) => t.id === oppId);
  if (!opp || oppId === undefined) return null;
  const acq = snapshot.acquisitions;
  const used = acq?.byTeam?.[oppId];
  // Without their count we can't say how many adds they have: don't pretend.
  if (acq?.limit != null && used === undefined) return null;
  const theirs: LeagueSnapshot = {
    ...snapshot,
    myTeamId: oppId,
    teams: snapshot.teams.map((t) => ({ ...t, isMyTeam: t.id === oppId })),
    acquisitions: acq ? { ...acq, used: used ?? 0 } : acq,
  };
  const plan = buildStreamingPlan(theirs, [], []);
  if (!plan) return null;
  const pointsGain = Math.round(plan.after.points - plan.baseline.points);
  return {
    name: opp.name,
    addsLeft: plan.addsLeft,
    games: plan.baseline.usableGames,
    gamesWithMoves: plan.after.usableGames,
    pointsGain,
    moves: plan.moves.length,
    outlook: plan.outlook,
    picks: plan.moves.map((m) => ({ addId: m.add.id, add: m.add.name, addTeam: m.add.nbaTeamAbbrev, drop: m.drop.name, gain: Math.round(m.pointsGain), after: m.swapAfter?.label })),
    projected: plan.matchup?.me.projected,
    projectedWithMoves: plan.matchup?.me.withMoves,
  };
}
