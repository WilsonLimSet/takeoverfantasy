/**
 * Fantasy Basketball Optimizer
 * The daily briefing: waiver ranking and injury openings for This week.
 */

import type {
  LeagueSnapshot,
  Player,
  WaiverRecommendation,
  InjuryOpportunity,
  NBATeamSchedule,
  DailyBriefing,
  StatusChange,
  PlayerStatus,
  InjuryHistoryIndex,
} from '@/types';
import { getInjuryRiskAssessment, formatInjuryRisk } from '@/lib/inseason/injuryTracker';

// ============ Scoring Weights ============

// Weights optimized for streaming leagues (maximize games)
const WAIVER_WEIGHTS = {
  projectedPoints: 0.40,
  gamesNext7: 0.45,  // Heavily weight games for streaming value
  recentTrend: 0.15,
};

// Injury statuses that should exclude players from recommendations
const INJURED_STATUSES: PlayerStatus[] = ['OUT', 'INJURY_RESERVE', 'SUSPENSION'];


// ============ Waiver Wire Ranking ============

/**
 * Score a player for waiver wire ranking
 */
function scoreWaiverCandidate(
  player: Player,
  schedule: NBATeamSchedule | undefined
): { score: number; details: { projected: number; games: number; trend: number } } {
  const gamesNext7 = schedule?.gamesNext7Days || 3;
  const projectedAvg = player.stats?.projectedAvg || 15;
  const seasonAvg = player.stats?.seasonAvg || projectedAvg;

  // Calculate projected points for next 7 days
  const projectedPointsNext7 = projectedAvg * gamesNext7;

  // Calculate trend (% difference from season average)
  const recentTrend = seasonAvg > 0
    ? ((projectedAvg - seasonAvg) / seasonAvg) * 100
    : 0;

  // Normalize components
  const normalizedProjected = projectedPointsNext7;
  const normalizedGames = gamesNext7 * 10; // Scale to be comparable
  const normalizedTrend = Math.max(-20, Math.min(20, recentTrend));

  const score =
    WAIVER_WEIGHTS.projectedPoints * normalizedProjected +
    WAIVER_WEIGHTS.gamesNext7 * normalizedGames +
    WAIVER_WEIGHTS.recentTrend * normalizedTrend;

  return {
    score,
    details: {
      projected: projectedPointsNext7,
      games: gamesNext7,
      trend: recentTrend,
    },
  };
}

/**
 * Generate reasons for waiver recommendation
 */
function generateWaiverReasons(
  player: Player,
  games: number,
  trend: number,
  schedule: NBATeamSchedule | undefined
): string[] {
  const reasons: string[] = [];

  if (games >= 4) {
    reasons.push(`${games} games in next 7 days`);
  } else if (games === 3) {
    reasons.push('Average schedule (3 games)');
  }

  if (trend > 15) {
    reasons.push('Hot streak (+' + trend.toFixed(0) + '% vs avg)');
  } else if (trend > 5) {
    reasons.push('Trending up');
  } else if (trend < -10) {
    reasons.push('⚠️ Trending down');
  }

  if (player.ownership) {
    if (player.ownership.percentOwned > 70) {
      reasons.push('Widely rostered (' + player.ownership.percentOwned.toFixed(0) + '%)');
    }
    if (player.ownership.percentChange > 10) {
      reasons.push('🔥 Rising fast (+' + player.ownership.percentChange.toFixed(0) + '%)');
    }
  }

  if (player.positions.length > 2) {
    reasons.push('Multi-position eligible');
  }

  return reasons;
}

/**
 * Check if a player is injured and should be excluded
 */
function isPlayerInjured(player: Player): boolean {
  return INJURED_STATUSES.includes(player.status);
}

/**
 * Get top waiver recommendations
 * Filters out injured players (OUT, IR, SUSPENDED)
 * Applies injury history penalty to injury-prone players
 */
function getWaiverRecommendations(
  snapshot: LeagueSnapshot,
  limit = 10,
  injuryHistory?: InjuryHistoryIndex | null
): WaiverRecommendation[] {
  const recommendations: WaiverRecommendation[] = [];

  for (const fa of snapshot.freeAgentsTopN) {
    // Skip injured players - they won't help you win games
    if (isPlayerInjured(fa.player)) {
      continue;
    }

    const schedule = snapshot.scheduleIndex[fa.player.nbaTeamId];
    const { score: baseScore, details } = scoreWaiverCandidate(fa.player, schedule);
    const reasons = generateWaiverReasons(fa.player, details.games, details.trend, schedule);

    // Apply injury history penalty
    let score = baseScore;
    if (injuryHistory) {
      const injuryRisk = getInjuryRiskAssessment(fa.player.id, injuryHistory);
      score = baseScore * injuryRisk.scorePenalty;

      // Add injury risk warning to reasons
      if (injuryRisk.riskLevel !== 'LOW') {
        const riskNote = formatInjuryRisk(injuryRisk);
        if (riskNote) {
          reasons.push(`⚠️ ${riskNote}`);
        }
        if (injuryRisk.riskLevel === 'HIGH') {
          reasons.push(`🏥 Injury-prone (${injuryRisk.gamesMissedPct.toFixed(0)}% games missed)`);
        }
      }
    }

    // Flag questionable/DTD players but don't exclude them
    if (fa.player.status === 'DAY_TO_DAY' || fa.player.status === 'QUESTIONABLE') {
      reasons.unshift(`⚠️ ${fa.player.status.replace('_', ' ')}`);
    }

    // Determine confidence - lower for DTD/Questionable or injury-prone
    let confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'MEDIUM';
    const injuryRisk = injuryHistory ? getInjuryRiskAssessment(fa.player.id, injuryHistory) : null;

    if (fa.player.status === 'DAY_TO_DAY' || fa.player.status === 'QUESTIONABLE') {
      confidence = 'LOW';
    } else if (injuryRisk?.riskLevel === 'HIGH') {
      confidence = 'LOW';
    } else if (injuryRisk?.riskLevel === 'MEDIUM') {
      confidence = 'MEDIUM';
    } else if (details.games >= 4 && details.trend > 5) {
      confidence = 'HIGH';
    } else if (details.games <= 2 || details.trend < -10) {
      confidence = 'LOW';
    }

    recommendations.push({
      rank: 0, // Will be set after sorting
      player: fa.player,
      score,
      projectedPointsNext7: details.projected,
      gamesNext7: details.games,
      recentTrend: details.trend,
      reasons,
      confidence,
    });
  }

  // Sort by score and assign ranks
  recommendations.sort((a, b) => b.score - a.score);
  recommendations.forEach((rec, idx) => {
    rec.rank = idx + 1;
  });

  return recommendations.slice(0, limit);
}

// ============ Weekly Streaming Plan ============



// ============ Injury Opportunity Detection ============

/**
 * Find players who could benefit from an injury
 */
function detectInjuryOpportunities(
  snapshot: LeagueSnapshot,
  statusChanges: StatusChange[]
): InjuryOpportunity[] {
  const opportunities: InjuryOpportunity[] = [];

  // Filter for new injuries on rostered players
  const newInjuries = statusChanges.filter(
    (change) =>
      change.isMyPlayer &&
      (change.currentStatus === 'OUT' ||
        change.currentStatus === 'INJURY_RESERVE' ||
        change.currentStatus === 'DAY_TO_DAY')
  );

  for (const injury of newInjuries) {
    // Find the injured player's team
    const myTeam = snapshot.teams.find((t) => t.id === snapshot.myTeamId);
    const injuredEntry = myTeam?.roster?.find((r) => r.playerId === injury.playerId);
    if (!injuredEntry) continue;

    const injuredPlayer = injuredEntry.player;

    // Find available players on the same NBA team
    const sameTeamFAs = snapshot.freeAgentsTopN.filter(
      (fa) => fa.player.nbaTeamId === injuredPlayer.nbaTeamId
    );

    if (sameTeamFAs.length === 0) continue;

    // Score beneficiaries
    const beneficiaries = sameTeamFAs
      .map((fa) => {
        const schedule = snapshot.scheduleIndex[fa.player.nbaTeamId];
        const { score, details } = scoreWaiverCandidate(fa.player, schedule);

        // Boost score for same position
        const samePosition = fa.player.positions.some((pos) =>
          injuredPlayer.positions.includes(pos)
        );
        const boostedScore = samePosition ? score * 1.2 : score;

        // Determine confidence
        let confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'MEDIUM';
        if (samePosition && details.games >= 3) {
          confidence = 'HIGH';
        } else if (!samePosition || details.games <= 2) {
          confidence = 'LOW';
        }

        const reasons: string[] = [];
        if (samePosition) reasons.push('Same position - likely usage boost');
        if (details.games >= 4) reasons.push(`${details.games} games upcoming`);
        if (fa.player.ownership && fa.player.ownership.percentChange > 5) {
          reasons.push('Rising ownership');
        }

        return {
          player: fa.player,
          score: boostedScore,
          confidence,
          reasons,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    opportunities.push({
      injuredPlayer,
      injuryStatus: injury.currentStatus,
      injuryNote: injury.injuryNote,
      beneficiaries,
      timestamp: injury.timestamp,
    });
  }

  return opportunities;
}

// ============ Daily Briefing Generation ============

/**
 * Generate daily briefing
 */
export function generateDailyBriefing(
  snapshot: LeagueSnapshot,
  statusChanges: StatusChange[]
): DailyBriefing {
  const myTeam = snapshot.teams.find((t) => t.id === snapshot.myTeamId);
  if (!myTeam) {
    throw new Error('My team not found in snapshot');
  }

  // Get waiver recommendations
  const topWaiverAdds = getWaiverRecommendations(snapshot, 5);

  // Detect injury opportunities
  const injuryOpportunities = detectInjuryOpportunities(snapshot, statusChanges);

  // Build upcoming games list
  const upcomingGames = (myTeam.roster || []).map((entry) => ({
    player: entry.player,
    nextGameDate: undefined, // Would need schedule data
    opponent: undefined,
  }));

  // Build action items
  const actionItems: string[] = [];

  const myStatusChanges = statusChanges.filter((sc) => sc.isMyPlayer);
  if (myStatusChanges.length > 0) {
    const outPlayers = myStatusChanges.filter(
      (sc) => sc.currentStatus === 'OUT' || sc.currentStatus === 'INJURY_RESERVE'
    );
    if (outPlayers.length > 0) {
      actionItems.push(
        `⚠️ ${outPlayers.length} player(s) now OUT - consider replacements`
      );
    }
  }

  if (topWaiverAdds.length > 0 && topWaiverAdds[0].confidence === 'HIGH') {
    actionItems.push(
      `🌟 High-confidence add: ${topWaiverAdds[0].player.name} (${topWaiverAdds[0].gamesNext7} games)`
    );
  }

  if (injuryOpportunities.length > 0) {
    actionItems.push(
      `🏥 ${injuryOpportunities.length} injury opportunity alert(s)`
    );
  }

  // Build diff summary
  const diffSummary: string[] = [];
  if (myStatusChanges.length > 0) {
    diffSummary.push(`${myStatusChanges.length} roster player status change(s)`);
  }

  return {
    generatedAt: Date.now(),
    week: snapshot.week,
    myTeam,
    statusChanges,
    upcomingGames,
    actionItems,
    topWaiverAdds,
    injuryOpportunities,
    diffSummary,
  };
}

// ============ Drop Recommendations ============

