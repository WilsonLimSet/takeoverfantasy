/**
 * Smart Alerts Generator
 * Context-aware alerts about injuries/returns affecting YOUR roster and watchlist
 *
 * Key insight: ESPN already shows top adds. We alert on OPPORTUNITIES:
 * - Teammate of your roster player injured → your player's usage goes UP
 * - Teammate of your roster player returns → your player's usage goes DOWN
 * - Teammate of watchlist player injured → watchlist player worth adding
 * - Teammate of watchlist player returns → watchlist player less valuable
 *
 * IMPORTANT: Only HIGH-USAGE stars matter for usage redistribution.
 * Zubac (role player center) out doesn't help Harden.
 * Kawhi (high-usage wing) out DOES help Harden - touches redistribute to everyone.
 */

import type {
  LeagueSnapshot,
  SnapshotDiff,
  StatusChange,
  SmartAlert,
  Player,
  Watchlist,
  PlayerStatus,
  LeagueTransaction,
} from '@/types';

// Injury statuses that indicate player is OUT
const OUT_STATUSES: PlayerStatus[] = ['OUT', 'INJURY_RESERVE', 'SUSPENSION'];

// Status severity ranking (lower = healthier/better)
// Used to detect status improvements vs declines
const STATUS_SEVERITY: Record<PlayerStatus, number> = {
  'ACTIVE': 0,
  'PROBABLE': 1,
  'QUESTIONABLE': 2,
  'DAY_TO_DAY': 3,
  'DOUBTFUL': 4,
  'OUT': 5,
  'INJURY_RESERVE': 6,
  'SUSPENSION': 7,
};

// High-usage stars threshold - these are true usage monsters
// When they're out, the whole team's usage shifts (not just their position)
const STAR_THRESHOLD = 25; // Starter-level players whose absence redistributes usage

// Threshold for alerting on dropped players - only elite players
const DROPPED_PLAYER_THRESHOLD = 35; // Only alert on 35+ pts drops

// Streamer threshold - players below this are "streamers" worth schedule alerts
const STREAMER_THRESHOLD = 30; // Players under 30 pts are streaming candidates

/**
 * Check if a player is a HIGH-USAGE STAR whose absence redistributes touches
 * This is NOT about position - it's about usage rate and shot volume
 *
 * Examples:
 * - Kawhi (40+ pts) → HIGH IMPACT - his touches go to everyone
 * - Zubac (18 pts) → LOW IMPACT - he's a role player, just catches lobs
 * - Harden (45+ pts) → HIGH IMPACT - primary ball handler
 */
function isHighUsageStar(player: Player): boolean {
  const projectedAvg = player.stats?.projectedAvg || 0;
  // Only true stars (top ~30-40 players) create real usage shifts
  return projectedAvg >= STAR_THRESHOLD;
}

/**
 * Check if two players share a position (same minutes pool)
 * Examples: Both are C, both are PG, one is SG/SF and other is SF
 */
function sharesPosition(player1: Player, player2: Player): boolean {
  // Check if any position overlaps
  return player1.positions.some(pos => player2.positions.includes(pos));
}

/**
 * Check if changedPlayer's injury impacts beneficiary
 * Returns true if:
 * - changedPlayer is a high-usage star (affects whole team), OR
 * - changedPlayer shares position with beneficiary (competes for minutes)
 */
function isImpactfulForPlayer(changedPlayer: Player, beneficiary: Player): boolean {
  // Star-based: high-usage players affect everyone on the team
  if (isHighUsageStar(changedPlayer)) return true;

  // Position-based: same-position players compete for minutes
  if (sharesPosition(changedPlayer, beneficiary)) return true;

  return false;
}

/**
 * Check if player just went OUT (was active/DTD before, now OUT)
 */
function justWentOut(change: StatusChange): boolean {
  const wasAvailable = !OUT_STATUSES.includes(change.previousStatus);
  const isNowOut = OUT_STATUSES.includes(change.currentStatus);
  return wasAvailable && isNowOut;
}

/**
 * Check if player just returned (was OUT, now active)
 */
function justReturned(change: StatusChange): boolean {
  const wasOut = OUT_STATUSES.includes(change.previousStatus);
  const isNowAvailable = change.currentStatus === 'ACTIVE';
  return wasOut && isNowAvailable;
}

/**
 * Check if player's status improved (closer to playing)
 * Examples: QUESTIONABLE → PROBABLE, DOUBTFUL → QUESTIONABLE, OUT → QUESTIONABLE
 * Excludes: full return to ACTIVE (handled by justReturned)
 */
function statusImproved(change: StatusChange): boolean {
  const prevSeverity = STATUS_SEVERITY[change.previousStatus];
  const currSeverity = STATUS_SEVERITY[change.currentStatus];
  // Status improved if severity decreased (lower = healthier)
  // Exclude ACTIVE returns (handled separately) and same-status
  return currSeverity < prevSeverity && change.currentStatus !== 'ACTIVE';
}

/**
 * Check if player's status declined (further from playing)
 * Examples: ACTIVE → QUESTIONABLE, PROBABLE → DOUBTFUL, QUESTIONABLE → OUT
 * Excludes: going fully OUT (handled by justWentOut)
 */
function statusDeclined(change: StatusChange): boolean {
  const prevSeverity = STATUS_SEVERITY[change.previousStatus];
  const currSeverity = STATUS_SEVERITY[change.currentStatus];
  // Status declined if severity increased (higher = worse)
  // Exclude going fully OUT (handled separately) and same-status
  return currSeverity > prevSeverity && !OUT_STATUSES.includes(change.currentStatus);
}

/**
 * Get a human-readable status label with emoji
 */
function getStatusLabel(status: PlayerStatus): string {
  const labels: Record<PlayerStatus, string> = {
    'ACTIVE': '✅ Active',
    'PROBABLE': '🟡 Probable',
    'QUESTIONABLE': '❓ Questionable',
    'DAY_TO_DAY': '⚠️ Day-to-Day',
    'DOUBTFUL': '⁉️ Doubtful',
    'OUT': '🔴 Out',
    'INJURY_RESERVE': '🔴 IR',
    'SUSPENSION': '🔴 Suspended',
  };
  return labels[status] || status;
}


/**
 * Find a player in the snapshot by ID
 */
function findPlayerById(playerId: number, snapshot: LeagueSnapshot): Player | null {
  // Check all team rosters
  for (const team of snapshot.teams) {
    if (team.roster) {
      const entry = team.roster.find(r => r.playerId === playerId);
      if (entry) return entry.player;
    }
  }

  // Check free agents
  const fa = snapshot.freeAgentsTopN.find(f => f.player.id === playerId);
  if (fa) return fa.player;

  return null;
}



/**
 * Check if a player is a streamer (below star threshold, worth schedule optimization)
 */
function isStreamer(player: Player): boolean {
  const projectedAvg = player.stats?.projectedAvg || 0;
  return projectedAvg < STREAMER_THRESHOLD && projectedAvg > 0;
}

/**
 * Get next N days as date strings (YYYY-MM-DD format)
 */
function getNextNDays(n: number): string[] {
  const days: string[] = [];
  const today = new Date();
  for (let i = 0; i < n; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    days.push(date.toISOString().split('T')[0]);
  }
  return days;
}



/**
 * Generate schedule-based alerts for streamers
 * Only alerts on EXCEPTIONS: dead zones (3+ days off) or light weeks
 */
function generateScheduleAlerts(
  snapshot: LeagueSnapshot,
  myRoster: Player[]
): SmartAlert[] {
  const alerts: SmartAlert[] = [];
  const now = Date.now();
  const next3Days = getNextNDays(3);
  const next7Days = getNextNDays(7);

  // Only check streamers (< 30 pts avg)
  const streamers = myRoster.filter(p => isStreamer(p));
  if (streamers.length === 0) return alerts;

  // Calculate games this week for each streamer
  const streamerGames: { player: Player; games: number }[] = [];

  for (const player of streamers) {
    const schedule = snapshot.scheduleIndex[player.nbaTeamId];
    if (!schedule) continue;

    const gamesThisWeek = next7Days.filter(day => schedule.gamesByDay[day]).length;
    streamerGames.push({ player, games: gamesThisWeek });
  }

  // Find average games
  const avgGames = streamerGames.reduce((sum, s) => sum + s.games, 0) / streamerGames.length;

  const warnings: string[] = [];

  for (const { player, games } of streamerGames) {
    const schedule = snapshot.scheduleIndex[player.nbaTeamId];
    if (!schedule) continue;

    // Dead zone: no games in next 3 days
    const hasGameNext3 = next3Days.some(day => schedule.gamesByDay[day]);
    if (!hasGameNext3) {
      warnings.push(`⏸️ ${player.name} - no games next 3 days`);
      continue;
    }

    // Light week: 2+ fewer games than average
    if (games <= avgGames - 2 && games <= 2) {
      warnings.push(`📉 ${player.name} - only ${games} games this week`);
    }
  }

  if (warnings.length > 0) {
    alerts.push({
      type: 'WEEKLY_SUMMARY',
      priority: 'MEDIUM',
      title: '',
      playerName: '',
      teamAbbrev: '',
      details: warnings.join('\n'),
      timestamp: now,
    });
  }

  return alerts;
}

/**
 * Generate smart alerts from snapshot diff
 * FOCUSED ON: How injuries/returns affect YOUR roster and watchlist
 * Also tracks league activity (adds/drops by other teams)
 */
export function generateSmartAlerts(
  snapshot: LeagueSnapshot,
  diff: SnapshotDiff,
  watchlist: Watchlist | null,
  recentTransactions?: LeagueTransaction[]
): SmartAlert[] {
  const alerts: SmartAlert[] = [];
  const now = Date.now();
  const myTeam = snapshot.teams.find(t => t.id === snapshot.myTeamId);
  const myRosterPlayerIds = new Set(myTeam?.roster?.map(r => r.playerId) || []);
  const watchlistPlayerIds = new Set(watchlist?.playerIds || []);

  // Build a map of NBA team -> players we care about (roster + watchlist)
  const playersWeCareAbout: Map<number, Player[]> = new Map();

  // Add roster players
  if (myTeam?.roster) {
    for (const entry of myTeam.roster) {
      const teamId = entry.player.nbaTeamId;
      if (!playersWeCareAbout.has(teamId)) {
        playersWeCareAbout.set(teamId, []);
      }
      playersWeCareAbout.get(teamId)!.push(entry.player);
    }
  }

  // Add watchlist players
  if (watchlist) {
    for (const playerId of watchlist.playerIds) {
      const player = findPlayerById(playerId, snapshot);
      if (player) {
        const teamId = player.nbaTeamId;
        if (!playersWeCareAbout.has(teamId)) {
          playersWeCareAbout.set(teamId, []);
        }
        // Avoid duplicates
        if (!playersWeCareAbout.get(teamId)!.some(p => p.id === player.id)) {
          playersWeCareAbout.get(teamId)!.push(player);
        }
      }
    }
  }

  // Process each status change
  for (const change of diff.statusChanges) {
    const changedPlayer = findPlayerById(change.playerId, snapshot);
    if (!changedPlayer) continue;

    const isMyPlayer = myRosterPlayerIds.has(change.playerId);
    const isWatchlistPlayer = watchlistPlayerIds.has(change.playerId);
    const wentOut = justWentOut(change);
    const returned = justReturned(change);

    // 1. MY PLAYER GOT INJURED
    if (isMyPlayer && wentOut) {
      alerts.push({
        type: 'ROSTER_INJURY',
        priority: 'HIGH',
        title: `🚨 ${change.playerName} is OUT`,
        playerName: change.playerName,
        teamAbbrev: changedPlayer.nbaTeamAbbrev,
        details: change.injuryNote || `Status: ${change.currentStatus}`,
        action: 'Find a replacement on waivers',
        timestamp: now,
      });
      continue;
    }

    // 2. MY PLAYER RETURNED
    if (isMyPlayer && returned) {
      alerts.push({
        type: 'ROSTER_RETURN',
        priority: 'MEDIUM',
        title: `✅ ${change.playerName} is BACK`,
        playerName: change.playerName,
        teamAbbrev: changedPlayer.nbaTeamAbbrev,
        details: 'Returned from injury',
        action: 'Move to starting lineup',
        timestamp: now,
      });
      continue;
    }

    // 3. WATCHLIST PLAYER GOT INJURED
    // Alert user NOT to add them right now
    if (isWatchlistPlayer && wentOut) {
      alerts.push({
        type: 'WATCHLIST_OPPORTUNITY',
        priority: 'MEDIUM',
        title: `⚠️ ${change.playerName} is OUT`,
        playerName: change.playerName,
        teamAbbrev: changedPlayer.nbaTeamAbbrev,
        details: change.injuryNote || `Status: ${change.currentStatus}`,
        action: 'Hold off on adding - wait for return',
        timestamp: now,
      });
      continue;
    }

    // 4. WATCHLIST PLAYER RETURNED
    // Alert user NOW is a good time to add them
    if (isWatchlistPlayer && returned) {
      const seasonAvg = changedPlayer.stats?.seasonAvg || 0;
      const avgStr = seasonAvg > 0 ? ` (${seasonAvg.toFixed(1)})` : '';
      alerts.push({
        type: 'WATCHLIST_OPPORTUNITY',
        priority: 'HIGH',
        title: `🔥 ${change.playerName}${avgStr} is BACK`,
        playerName: change.playerName,
        teamAbbrev: changedPlayer.nbaTeamAbbrev,
        details: 'Returned from injury - good time to add!',
        action: `Pick up ${change.playerName} now`,
        timestamp: now,
      });
      continue;
    }

    // 5. INTERMEDIATE STATUS CHANGES (not full OUT or full ACTIVE)
    // Alert on status upgrades (QUESTIONABLE → PROBABLE) or downgrades (ACTIVE → QUESTIONABLE)
    const improved = statusImproved(change);
    const declined = statusDeclined(change);

    if (isMyPlayer && improved) {
      alerts.push({
        type: 'ROSTER_RETURN',
        priority: 'MEDIUM',
        title: `📈 ${change.playerName} status improved`,
        playerName: change.playerName,
        teamAbbrev: changedPlayer.nbaTeamAbbrev,
        details: `${getStatusLabel(change.previousStatus)} → ${getStatusLabel(change.currentStatus)}`,
        action: 'May be able to play - monitor closely',
        timestamp: now,
      });
      continue;
    }

    if (isMyPlayer && declined) {
      alerts.push({
        type: 'ROSTER_INJURY',
        priority: 'MEDIUM',
        title: `📉 ${change.playerName} status declined`,
        playerName: change.playerName,
        teamAbbrev: changedPlayer.nbaTeamAbbrev,
        details: `${getStatusLabel(change.previousStatus)} → ${getStatusLabel(change.currentStatus)}`,
        action: 'Have a backup ready',
        timestamp: now,
      });
      continue;
    }

    if (isWatchlistPlayer && improved) {
      const seasonAvg = changedPlayer.stats?.seasonAvg || 0;
      const avgStr = seasonAvg > 0 ? ` (${seasonAvg.toFixed(1)})` : '';
      alerts.push({
        type: 'WATCHLIST_OPPORTUNITY',
        priority: 'MEDIUM',
        title: `📈 ${change.playerName}${avgStr} status improved`,
        playerName: change.playerName,
        teamAbbrev: changedPlayer.nbaTeamAbbrev,
        details: `${getStatusLabel(change.previousStatus)} → ${getStatusLabel(change.currentStatus)}`,
        action: 'Getting closer to return - consider adding',
        timestamp: now,
      });
      continue;
    }

    if (isWatchlistPlayer && declined) {
      alerts.push({
        type: 'WATCHLIST_OPPORTUNITY',
        priority: 'LOW',
        title: `📉 ${change.playerName} status declined`,
        playerName: change.playerName,
        teamAbbrev: changedPlayer.nbaTeamAbbrev,
        details: `${getStatusLabel(change.previousStatus)} → ${getStatusLabel(change.currentStatus)}`,
        action: 'Hold off on adding for now',
        timestamp: now,
      });
      continue;
    }

    // 6. TEAMMATE OF MY ROSTER/WATCHLIST PLAYER CHANGED STATUS (fully OUT or ACTIVE only)
    // Alert when: star injured (affects whole team) OR same-position player injured (more minutes)
    // Note: We only check wentOut/returned here since intermediate teammate changes aren't as impactful
    const affectedPlayers = playersWeCareAbout.get(changedPlayer.nbaTeamId) || [];
    // Filter to players who are impacted by this change (star OR position)
    const beneficiaries = affectedPlayers.filter(p =>
      p.id !== changedPlayer.id && isImpactfulForPlayer(changedPlayer, p)
    );

    if (beneficiaries.length === 0) continue;

    // Determine why this alert triggered (for user clarity)
    const isStar = isHighUsageStar(changedPlayer);

    // Separate roster vs watchlist beneficiaries
    const rosterBeneficiaries = beneficiaries.filter(p => myRosterPlayerIds.has(p.id));
    const watchlistBeneficiaries = beneficiaries.filter(p => watchlistPlayerIds.has(p.id));

    if (wentOut) {
      // Teammate injured = USAGE BOOST for our players
      if (rosterBeneficiaries.length > 0) {
        const names = rosterBeneficiaries.map(p => p.name).join(', ');
        const reason = isStar
          ? 'usage redistribution'
          : 'same position - more minutes';
        alerts.push({
          type: 'TEAMMATE_INJURY',
          priority: 'HIGH',
          title: `📈 ${changedPlayer.name} is OUT`,
          playerName: changedPlayer.name,
          teamAbbrev: changedPlayer.nbaTeamAbbrev,
          details: `Your ${names} should see MORE usage (${reason})`,
          action: 'Start them if on bench',
          relatedPlayers: rosterBeneficiaries.map(p => p.name),
          timestamp: now,
        });
      }

      if (watchlistBeneficiaries.length > 0) {
        const names = watchlistBeneficiaries.map(p => p.name).join(', ');
        const reason = isStar
          ? 'usage redistribution'
          : 'same position - more minutes';
        alerts.push({
          type: 'WATCHLIST_OPPORTUNITY',
          priority: 'HIGH',
          title: `🔥 Add ${names} - ${changedPlayer.name} is OUT`,
          playerName: changedPlayer.name,
          teamAbbrev: changedPlayer.nbaTeamAbbrev,
          details: `${changedPlayer.name} out = ${reason} for ${names}`,
          action: `Pick up ${watchlistBeneficiaries[0].name} now`,
          relatedPlayers: watchlistBeneficiaries.map(p => p.name),
          timestamp: now,
        });
      }
    }

    if (returned) {
      // Teammate returned = USAGE DROP for our players
      if (rosterBeneficiaries.length > 0) {
        const names = rosterBeneficiaries.map(p => p.name).join(', ');
        const reason = isStar
          ? 'usage redistribution'
          : 'same position - fewer minutes';
        alerts.push({
          type: 'TEAMMATE_RETURN',
          priority: 'MEDIUM',
          title: `📉 ${changedPlayer.name} is BACK`,
          playerName: changedPlayer.name,
          teamAbbrev: changedPlayer.nbaTeamAbbrev,
          details: `Your ${names} may see LESS usage now (${reason})`,
          action: 'Monitor their production',
          relatedPlayers: rosterBeneficiaries.map(p => p.name),
          timestamp: now,
        });
      }

      if (watchlistBeneficiaries.length > 0) {
        const names = watchlistBeneficiaries.map(p => p.name).join(', ');
        const reason = isStar
          ? 'usage redistribution'
          : 'same position - fewer minutes';
        alerts.push({
          type: 'WATCHLIST_OPPORTUNITY',
          priority: 'LOW',
          title: `⚠️ ${changedPlayer.name} is BACK`,
          playerName: changedPlayer.name,
          teamAbbrev: changedPlayer.nbaTeamAbbrev,
          details: `${names} value decreased - ${changedPlayer.name} back (${reason})`,
          action: 'Maybe remove from watchlist',
          relatedPlayers: watchlistBeneficiaries.map(p => p.name),
          timestamp: now,
        });
      }
    }
  }

  // ============ SCHEDULE-BASED ALERTS ============
  // Note: Injury alerts are now ONLY generated from status changes (diff)
  // to avoid re-alerting on existing injuries every run
  const myRosterPlayers = myTeam?.roster?.map(r => r.player) || [];
  // Alert on B2B games, heavy weeks, dead zones for streamers
  const scheduleAlerts = generateScheduleAlerts(snapshot, myRosterPlayers);
  alerts.push(...scheduleAlerts);

  // ============ LEAGUE ACTIVITY ALERTS ============
  // Track adds/drops by other teams
  if (recentTransactions && recentTransactions.length > 0) {
    // Build team name lookup
    const teamNameById = new Map(snapshot.teams.map(t => [t.id, t.name]));

    for (const tx of recentTransactions) {
      // Skip our own transactions
      if (tx.teamId === snapshot.myTeamId) continue;

      // Use enriched transaction data first, fallback to snapshot lookup
      const player = findPlayerById(tx.playerId, snapshot);
      const playerName = tx.playerName || player?.name || `Player #${tx.playerId}`;
      const teamName = teamNameById.get(tx.teamId) || `Team #${tx.teamId}`;
      // Use enriched seasonAvg from transaction, fallback to player lookup
      // Note: Use || not ?? since enrichment may return 0 when stats unavailable
      const seasonAvg = tx.playerSeasonAvg || player?.stats?.seasonAvg || 0;
      const teamAbbrev = tx.playerTeamAbbrev || player?.nbaTeamAbbrev;

      if (tx.type === 'DROP') {
        const isWatchlistDrop = watchlistPlayerIds.has(tx.playerId);
        const isEliteDrop = seasonAvg >= DROPPED_PLAYER_THRESHOLD;

        // Only alert if on watchlist OR above 35 pts
        if (isWatchlistDrop || isEliteDrop) {
          const avgStr = seasonAvg > 0 ? ` (${seasonAvg.toFixed(1)})` : '';
          alerts.push({
            type: 'HOT_WAIVER_ADD',
            priority: 'HIGH',
            title: `🎯 ${playerName}${avgStr} dropped by ${teamName}`,
            playerName: playerName,
            teamAbbrev: teamAbbrev,
            details: '',
            timestamp: now,
          });
        }
      }

      if (tx.type === 'ADD') {
        // Alert if a league mate added someone on our watchlist
        if (watchlistPlayerIds.has(tx.playerId)) {
          const avgStr = seasonAvg > 0 ? ` (${seasonAvg.toFixed(1)})` : '';
          alerts.push({
            type: 'WATCHLIST_OPPORTUNITY',
            priority: 'HIGH',  // Upgrade to HIGH - watchlist snipe is important
            title: `❌ ${playerName}${avgStr} SNIPED by ${teamName}`,
            playerName: playerName,
            teamAbbrev: teamAbbrev,
            details: `Was on your watchlist - no longer available`,
            action: 'Remove from watchlist',
            timestamp: now,
          });
        }
      }
    }
  }

  return alerts;
}

/**
 * Check if there are any alerts worth sending
 */
export function hasActionableAlerts(alerts: SmartAlert[]): boolean {
  return alerts.some(a => a.priority === 'HIGH' || a.priority === 'MEDIUM');
}

