/**
 * Injury History Tracker
 * Tracks player injury history over time to identify injury-prone players
 */

import type {
  LeagueSnapshot,
  PlayerStatus,
  InjuryHistoryIndex,
  InjuryRiskAssessment,
  Player,
  NBATeamSchedule,
} from '@/types';

// Statuses that count as "injured" (missing games)
const INJURY_STATUSES: PlayerStatus[] = ['OUT', 'INJURY_RESERVE', 'SUSPENSION'];


/**
 * Estimate games missed based on days between injury start and end
 * NBA teams play ~3.5 games per week on average
 */
function estimateGamesMissed(startDate: number, endDate: number, schedule?: NBATeamSchedule): number {
  const daysMissed = Math.ceil((endDate - startDate) / (24 * 60 * 60 * 1000));
  // Average ~0.5 games per day during regular season
  return Math.max(1, Math.round(daysMissed * 0.5));
}

/**
 * Update injury history based on current snapshot
 */
export function updateInjuryHistory(
  snapshot: LeagueSnapshot,
  previousHistory: InjuryHistoryIndex | null
): InjuryHistoryIndex {
  const history: InjuryHistoryIndex = previousHistory ? { ...previousHistory } : {};
  const now = snapshot.fetchedAt;

  // Collect all players from free agents and all team rosters
  const allPlayers: Player[] = [
    ...snapshot.freeAgentsTopN.map(fa => fa.player),
  ];

  for (const team of snapshot.teams) {
    if (team.roster) {
      allPlayers.push(...team.roster.map(r => r.player));
    }
  }

  // Process each player
  for (const player of allPlayers) {
    const isCurrentlyInjured = INJURY_STATUSES.includes(player.status);
    const existingHistory = history[player.id];

    if (!existingHistory) {
      // First time seeing this player
      history[player.id] = {
        playerId: player.id,
        playerName: player.name,
        nbaTeamId: player.nbaTeamId,
        totalGamesMissed: isCurrentlyInjured ? 1 : 0, // Start counting if injured
        totalGamesTracked: 1,
        injuryEvents: isCurrentlyInjured ? [{
          startDate: now,
          status: player.status,
          note: player.injuryNote,
          gamesMissed: 0, // Will accumulate
        }] : [],
        currentlyInjured: isCurrentlyInjured,
        lastUpdated: now,
      };
    } else {
      // Update existing history
      const wasInjured = existingHistory.currentlyInjured;

      // Increment games tracked (roughly every 6 hours = ~0.125 games)
      const hoursSinceUpdate = (now - existingHistory.lastUpdated) / (60 * 60 * 1000);
      const gamesElapsed = Math.round(hoursSinceUpdate / 48 * 3.5); // ~3.5 games per week

      existingHistory.totalGamesTracked += Math.max(0, gamesElapsed);

      if (isCurrentlyInjured && !wasInjured) {
        // Player just got injured - start new injury event
        existingHistory.injuryEvents.push({
          startDate: now,
          status: player.status,
          note: player.injuryNote,
          gamesMissed: 0,
        });
        existingHistory.currentlyInjured = true;
      } else if (!isCurrentlyInjured && wasInjured) {
        // Player returned from injury - close current injury event
        const currentEvent = existingHistory.injuryEvents[existingHistory.injuryEvents.length - 1];
        if (currentEvent && !currentEvent.endDate) {
          currentEvent.endDate = now;
          const schedule = snapshot.scheduleIndex[player.nbaTeamId];
          currentEvent.gamesMissed = estimateGamesMissed(currentEvent.startDate, now, schedule);
          existingHistory.totalGamesMissed += currentEvent.gamesMissed;
        }
        existingHistory.currentlyInjured = false;
      } else if (isCurrentlyInjured && wasInjured) {
        // Still injured - update games missed estimate
        const currentEvent = existingHistory.injuryEvents[existingHistory.injuryEvents.length - 1];
        if (currentEvent && !currentEvent.endDate) {
          // Update note if changed
          if (player.injuryNote) {
            currentEvent.note = player.injuryNote;
          }
          // Increment estimated games missed
          if (gamesElapsed > 0) {
            currentEvent.gamesMissed += gamesElapsed;
            existingHistory.totalGamesMissed += gamesElapsed;
          }
        }
      }

      existingHistory.lastUpdated = now;
      existingHistory.playerName = player.name; // Update in case of name changes
      existingHistory.nbaTeamId = player.nbaTeamId;

      history[player.id] = existingHistory;
    }
  }

  return history;
}

/**
 * Calculate injury risk assessment for a player
 */
export function getInjuryRiskAssessment(
  playerId: number,
  history: InjuryHistoryIndex | null
): InjuryRiskAssessment {
  const defaultAssessment: InjuryRiskAssessment = {
    playerId,
    riskLevel: 'LOW',
    gamesMissedPct: 0,
    injuryCount: 0,
    isCurrentlyInjured: false,
    scorePenalty: 1.0, // No penalty
  };

  if (!history || !history[playerId]) {
    return defaultAssessment;
  }

  const playerHistory = history[playerId];

  // Calculate percentage of games missed
  const gamesMissedPct = playerHistory.totalGamesTracked > 0
    ? (playerHistory.totalGamesMissed / playerHistory.totalGamesTracked) * 100
    : 0;

  const injuryCount = playerHistory.injuryEvents.length;
  const isCurrentlyInjured = playerHistory.currentlyInjured;

  // Determine risk level and penalty
  let riskLevel: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';
  let scorePenalty = 1.0;

  if (gamesMissedPct >= 30 || injuryCount >= 4) {
    // High risk: missed 30%+ games or 4+ separate injuries
    riskLevel = 'HIGH';
    scorePenalty = 0.6; // 40% penalty
  } else if (gamesMissedPct >= 15 || injuryCount >= 2) {
    // Medium risk: missed 15-30% or 2-3 injuries
    riskLevel = 'MEDIUM';
    scorePenalty = 0.8; // 20% penalty
  }

  // Additional penalty if currently injured
  if (isCurrentlyInjured) {
    scorePenalty *= 0.5; // Additional 50% penalty
  }

  return {
    playerId,
    riskLevel,
    gamesMissedPct,
    injuryCount,
    isCurrentlyInjured,
    scorePenalty,
  };
}


/**
 * Format injury risk for display
 */
export function formatInjuryRisk(assessment: InjuryRiskAssessment): string {
  if (assessment.riskLevel === 'LOW' && !assessment.isCurrentlyInjured) {
    return '';
  }

  const parts: string[] = [];

  if (assessment.isCurrentlyInjured) {
    parts.push('Currently injured');
  }

  if (assessment.gamesMissedPct >= 10) {
    parts.push(`${assessment.gamesMissedPct.toFixed(0)}% games missed`);
  }

  if (assessment.injuryCount >= 2) {
    parts.push(`${assessment.injuryCount} injuries this season`);
  }

  return parts.join(' • ');
}
