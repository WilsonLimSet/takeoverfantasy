/**
 * Data Transformation Layer
 * Converts ESPN API responses to internal normalized types
 */

import type {
  ESPNPlayer,
  ESPNTeam,
  ESPNMatchup,
  ESPNRosterEntry,
  ESPNFreeAgentResponse,
  ESPNLeagueSettings,
  PlayerStatus,
} from '@/types/espn';
import { buildMatchupWeek, buildNextMatchupWeek, countStartingSlots } from './matchupGames';
import type {
  Player,
  Team,
  RosterEntry,
  Matchup,
  FreeAgentEntry,
  LeagueSnapshot,
  NBATeamSchedule,
} from '@/types';
import { LINEUP_SLOT_MAP, POSITION_MAP } from '@/types/espn';
import { NBA_TEAMS } from './espnClient';

// ============ Player Transformation ============

function mapPlayerStatus(espnPlayer: ESPNPlayer): PlayerStatus {
  if (!espnPlayer.injured && !espnPlayer.injuryStatus) {
    return 'ACTIVE';
  }

  // Map ESPN injury status strings to our enum
  const statusMap: Record<string, PlayerStatus> = {
    'ACTIVE': 'ACTIVE',
    'DAY_TO_DAY': 'DAY_TO_DAY',
    'OUT': 'OUT',
    'INJURY_RESERVE': 'INJURY_RESERVE',
    'SUSPENSION': 'SUSPENSION',
    'DOUBTFUL': 'DOUBTFUL',
    'QUESTIONABLE': 'QUESTIONABLE',
    'PROBABLE': 'PROBABLE',
    'D': 'DAY_TO_DAY',
    'O': 'OUT',
    'IR': 'INJURY_RESERVE',
    'SSPD': 'SUSPENSION',
  };

  return statusMap[espnPlayer.injuryStatus || 'ACTIVE'] || 'ACTIVE';
}

function getPositionsFromSlots(eligibleSlots: number[]): string[] {
  const positions: Set<string> = new Set();

  // Primary positions only (0-4)
  for (const slot of eligibleSlots) {
    if (slot >= 0 && slot <= 4) {
      const pos = POSITION_MAP[slot as keyof typeof POSITION_MAP];
      if (pos) positions.add(pos);
    }
  }

  return Array.from(positions);
}

/**
 * Stat entries are keyed "<split><season>": split 00 = season, 01/02/03 = last 7/15/30 days,
 * 10 = projection. ESPN returns last season's entries too, so only the newest season is read.
 */
function extractPlayerStats(espnPlayer: ESPNPlayer): Player['stats'] {
  if (!espnPlayer.stats || espnPlayer.stats.length === 0) {
    return undefined;
  }

  // Per-game entries ("05<gameId>") aren't season keys; reading them as one hid every stat.
  const season = Math.max(...espnPlayer.stats.map((s) => (/^\d{6}$/.test(String(s.id)) ? Number(String(s.id).slice(2)) : 0)));
  const stats: Player['stats'] = {};

  for (const stat of espnPlayer.stats) {
    const id = String(stat.id);
    if (Number(id.slice(2)) !== season || stat.appliedAverage === undefined) continue;
    const split = id.slice(0, 2);
    if (stat.statSourceId === 0) {
      if (split === '00') {
        stats.seasonAvg = stat.appliedAverage;
        stats.gamesPlayed = stat.stats?.['42']; // GP
        stats.seasonMin = stat.averageStats?.['40'];
      }
      if (split === '01') stats.last7Avg = stat.appliedAverage;
      if (split === '02') stats.last15Avg = stat.appliedAverage;
      if (split === '03') stats.last30Avg = stat.appliedAverage;
    }
    if (stat.statSourceId === 1 && split === '10') {
      stats.projectedAvg = stat.appliedAverage;
      stats.projectedMin = stat.averageStats?.['40'];
      if (stat.appliedTotal !== undefined) stats.projectedTotal = stat.appliedTotal;
    }
  }

  return Object.keys(stats).length > 0 ? stats : undefined;
}

export function transformPlayer(espnPlayer: ESPNPlayer): Player {
  const nbaTeam = NBA_TEAMS[espnPlayer.proTeamId];

  return {
    id: espnPlayer.id,
    name: espnPlayer.fullName,
    firstName: espnPlayer.firstName,
    lastName: espnPlayer.lastName,
    nbaTeamId: espnPlayer.proTeamId,
    nbaTeamAbbrev: nbaTeam?.abbrev,
    positions: getPositionsFromSlots(espnPlayer.eligibleSlots),
    eligibleSlots: espnPlayer.eligibleSlots,
    status: mapPlayerStatus(espnPlayer),
    injuryNote: espnPlayer.injured ? (espnPlayer.injuryStatus as string) : undefined,
    ownership: espnPlayer.ownership,
    stats: extractPlayerStats(espnPlayer),
  };
}

// ============ Roster Transformation ============

function transformRosterEntry(entry: ESPNRosterEntry): RosterEntry | null {
  if (!entry.playerPoolEntry?.player) {
    return null;
  }

  const player = transformPlayer(entry.playerPoolEntry.player);
  const slotName = LINEUP_SLOT_MAP[entry.lineupSlotId] || 'UNKNOWN';

  return {
    playerId: entry.playerId,
    player,
    lineupSlot: slotName,
    lineupSlotId: entry.lineupSlotId,
    acquisitionDate: entry.acquisitionDate,
    appliedTotal: entry.playerPoolEntry.appliedStatTotal,
  };
}

// ============ Team Transformation ============

function transformTeam(espnTeam: ESPNTeam, myTeamId: number): Team {
  const roster = espnTeam.roster?.entries
    .map(transformRosterEntry)
    .filter((entry): entry is RosterEntry => entry !== null);

  return {
    id: espnTeam.id,
    abbrev: espnTeam.abbrev,
    name: `${espnTeam.name || ''} ${espnTeam.nickname || ''}`.trim() || espnTeam.abbrev,
    nickname: espnTeam.nickname,
    isMyTeam: espnTeam.id === myTeamId,
    owners: espnTeam.owners,
    record: espnTeam.record?.overall
      ? {
          wins: espnTeam.record.overall.wins,
          losses: espnTeam.record.overall.losses,
          ties: espnTeam.record.overall.ties,
          pointsFor: espnTeam.record.overall.pointsFor,
          pointsAgainst: espnTeam.record.overall.pointsAgainst,
        }
      : undefined,
    roster,
  };
}

// ============ Matchup Transformation ============

function transformMatchup(espnMatchup: ESPNMatchup, myTeamId: number): Matchup {
  const isHome = espnMatchup.home.teamId === myTeamId;
  const isAway = espnMatchup.away?.teamId === myTeamId;

  return {
    id: espnMatchup.id,
    week: espnMatchup.matchupPeriodId,
    homeTeamId: espnMatchup.home.teamId,
    awayTeamId: espnMatchup.away?.teamId,
    homePoints: espnMatchup.home.totalPointsLive || espnMatchup.home.totalPoints,
    awayPoints: espnMatchup.away?.totalPointsLive || espnMatchup.away?.totalPoints,
    isMyMatchup: isHome || isAway,
  };
}

// ============ Free Agent Transformation ============

function transformFreeAgents(
  response: ESPNFreeAgentResponse,
  scheduleIndex: Record<number, NBATeamSchedule>
): FreeAgentEntry[] {
  const entries: FreeAgentEntry[] = [];

  for (const entry of response.players || []) {
    if (!entry.player) continue;

    const player = transformPlayer(entry.player);
    const schedule = scheduleIndex[player.nbaTeamId];

    // Calculate score based on heuristics
    const projectedPointsNext7 = player.stats?.projectedAvg
      ? player.stats.projectedAvg * (schedule?.gamesNext7Days || 3)
      : 0;
    const gamesNext7 = schedule?.gamesNext7Days || 3;

    // Recent trend: compare projected to season avg (simplified)
    const recentTrend = player.stats?.projectedAvg && player.stats?.seasonAvg
      ? ((player.stats.projectedAvg - player.stats.seasonAvg) / player.stats.seasonAvg) * 100
      : 0;

    // Score formula: 0.55 * projected + 0.25 * games + 0.20 * trend
    const normalizedProjected = projectedPointsNext7;
    const normalizedGames = gamesNext7 * 10; // Scale games to be comparable
    const normalizedTrend = Math.max(-20, Math.min(20, recentTrend)); // Cap trend impact

    const score =
      0.55 * normalizedProjected +
      0.25 * normalizedGames +
      0.20 * normalizedTrend;

    const reasonCodes: string[] = [];
    if (gamesNext7 >= 4) reasonCodes.push('4+ games next 7 days');
    if (recentTrend > 10) reasonCodes.push('Hot streak');
    if (player.ownership && player.ownership.percentOwned > 50) {
      reasonCodes.push('Widely owned');
    }
    if (player.ownership && player.ownership.percentChange > 5) {
      reasonCodes.push('Rising ownership');
    }

    entries.push({
      player,
      score,
      projectedPointsNext7,
      gamesNext7,
      recentTrend,
      reasonCodes,
      onWaivers: entry.status === 'WAIVERS',
    });
  }

  // Sort by score descending
  entries.sort((a, b) => b.score - a.score);

  return entries;
}

// ============ Snapshot Building ============

function buildStatusIndex(
  teams: Team[]
): Record<number, { status: PlayerStatus; injuryNote?: string }> {
  const index: Record<number, { status: PlayerStatus; injuryNote?: string }> = {};

  for (const team of teams) {
    if (!team.roster) continue;
    for (const entry of team.roster) {
      index[entry.player.id] = {
        status: entry.player.status,
        injuryNote: entry.player.injuryNote,
      };
    }
  }

  return index;
}

/**
 * Build schedule index from ESPN pro team schedule data
 */
function buildScheduleIndex(
  nbaSchedule: Array<{
    id: number;
    abbrev: string;
    proGamesByScoringPeriod?: Record<string, Array<{ id: number; date: number }>>;
  }>,
  currentScoringPeriod: number,
  daysAhead = 7
): Record<number, NBATeamSchedule> {
  const index: Record<number, NBATeamSchedule> = {};

  // If no schedule data, fall back to defaults
  if (!nbaSchedule || nbaSchedule.length === 0) {
    console.warn('No NBA schedule data available, using defaults');
    for (const [teamIdStr, team] of Object.entries(NBA_TEAMS)) {
      const teamId = parseInt(teamIdStr, 10);
      index[teamId] = {
        teamId,
        teamAbbrev: team.abbrev,
        gamesThisWeek: 3,
        gamesNext7Days: 3,
        gamesByDay: {},
      };
    }
    return index;
  }

  // Calculate dates for the next 7 days
  const today = new Date();
  const dateStrings: string[] = [];
  for (let i = 0; i < daysAhead; i++) {
    const date = new Date(today.getTime() + i * 24 * 60 * 60 * 1000);
    dateStrings.push(date.toISOString().split('T')[0]);
  }

  // Build schedule for each team
  for (const team of nbaSchedule) {
    if (!team.proGamesByScoringPeriod) continue;

    const gamesByDay: Record<string, boolean> = {};
    let gamesNext7Days = 0;

    // Check each day in the range
    for (let i = 0; i < daysAhead; i++) {
      const periodId = String(currentScoringPeriod + i);
      const dateStr = dateStrings[i];

      const gamesOnDay = team.proGamesByScoringPeriod[periodId];
      if (gamesOnDay && gamesOnDay.length > 0) {
        gamesByDay[dateStr] = true;
        gamesNext7Days++;
      } else {
        gamesByDay[dateStr] = false;
      }
    }

    index[team.id] = {
      teamId: team.id,
      teamAbbrev: team.abbrev,
      gamesThisWeek: gamesNext7Days, // For weekly matchups
      gamesNext7Days,
      gamesByDay,
    };
  }

  return index;
}

interface SnapshotInput {
  settings: ESPNLeagueSettings;
  teams: ESPNTeam[];
  matchups: ESPNMatchup[];
  freeAgents: ESPNFreeAgentResponse;
  myTeamId: number;
  nbaSchedule?: Array<{
    id: number;
    abbrev: string;
    proGamesByScoringPeriod?: Record<string, Array<{ id: number; date: number }>>;
  }>;
}

export function buildLeagueSnapshot(input: SnapshotInput): LeagueSnapshot {
  // Build real schedule index from ESPN data
  const scheduleIndex = buildScheduleIndex(
    input.nbaSchedule || [],
    input.settings.scoringPeriodId,
    7
  );

  const teams = input.teams.map((t) => transformTeam(t, input.myTeamId));
  const matchups = input.matchups.map((m) => transformMatchup(m, input.myTeamId));
  // Top free agents plus any watchlisted ones (fetched by id).
  const freeAgentsTopN = transformFreeAgents(input.freeAgents, scheduleIndex).slice(0, 300);
  const statusIndex = buildStatusIndex(teams);
  const matchupPeriods = input.settings.settings?.scheduleSettings?.matchupPeriods;
  const matchupWeek = buildMatchupWeek(input.nbaSchedule || [], matchupPeriods, input.settings.currentMatchupPeriod, input.settings.scoringPeriodId);

  return {
    fetchedAt: Date.now(),
    leagueId: input.settings.id,
    seasonId: input.settings.seasonId,
    week: input.settings.currentMatchupPeriod,
    scoringPeriodId: input.settings.scoringPeriodId,
    teams,
    myTeamId: input.myTeamId,
    matchups,
    freeAgentsTopN,
    statusIndex,
    scheduleIndex,
    matchupWeek,
    nextMatchupWeek: buildNextMatchupWeek(input.nbaSchedule || [], matchupPeriods, input.settings.currentMatchupPeriod, matchupWeek),
    startingSlots: countStartingSlots(input.settings.settings?.rosterSettings?.lineupSlotCounts),
    lineupSlots: input.settings.settings?.rosterSettings?.lineupSlotCounts,
    acquisitions: acquisitionsThisWeek(input),
    scoringType: input.settings.settings?.scoringSettings?.scoringType,
  };
}

/** Pickup limit for this matchup and how many my team has used. */
function acquisitionsThisWeek(input: SnapshotInput): { limit: number | null; used: number; byTeam: Record<number, number> } {
  const acq = input.settings.settings?.acquisitionSettings;
  const period = input.settings.currentMatchupPeriod;
  const days = Math.max(1, input.settings.settings?.scheduleSettings?.matchupPeriods?.[String(period)]?.length ?? 7);
  const raw = acq?.matchupAcquisitionLimit ?? -1;
  let limit: number | null = null;
  if (raw > 0) limit = acq?.matchupLimitPerScoringPeriod ? Math.round(raw * (days > 1 ? days : 7)) : Math.round(raw);
  const usedBy = (t: (typeof input.teams)[number]) => t.transactionCounter?.matchupAcquisitionTotals?.[String(period)] ?? 0;
  const me = input.teams.find((t) => t.id === input.myTeamId);
  return { limit, used: me ? usedBy(me) : 0, byTeam: Object.fromEntries(input.teams.map((t) => [t.id, usedBy(t)])) };
}

// ============ Diff Calculation ============

import type { SnapshotDiff, StatusChange } from '@/types';

export function calculateSnapshotDiff(
  previous: LeagueSnapshot | null,
  current: LeagueSnapshot
): SnapshotDiff {
  const statusChanges: StatusChange[] = [];
  const newTopWaiverCandidates: FreeAgentEntry[] = [];
  const removedTopWaiverCandidates: FreeAgentEntry[] = [];

  if (previous) {
    // Check for status changes
    for (const [playerIdStr, currentStatus] of Object.entries(current.statusIndex)) {
      const playerId = parseInt(playerIdStr, 10);
      const previousStatus = previous.statusIndex[playerId];

      if (previousStatus && previousStatus.status !== currentStatus.status) {
        // Find the player name from roster
        let playerName = `Player ${playerId}`;
        let isMyPlayer = false;

        const myTeam = current.teams.find((t) => t.id === current.myTeamId);
        const playerEntry = myTeam?.roster?.find((r) => r.playerId === playerId);
        if (playerEntry) {
          playerName = playerEntry.player.name;
          isMyPlayer = true;
        }

        statusChanges.push({
          playerId,
          playerName,
          previousStatus: previousStatus.status,
          currentStatus: currentStatus.status,
          isMyPlayer,
          injuryNote: currentStatus.injuryNote,
          timestamp: current.fetchedAt,
        });
      }
    }

    // Check for waiver list changes
    const previousPlayerIds = new Set(previous.freeAgentsTopN.map((fa) => fa.player.id));
    const currentPlayerIds = new Set(current.freeAgentsTopN.map((fa) => fa.player.id));

    for (const fa of current.freeAgentsTopN) {
      if (!previousPlayerIds.has(fa.player.id)) {
        newTopWaiverCandidates.push(fa);
      }
    }

    for (const fa of previous.freeAgentsTopN) {
      if (!currentPlayerIds.has(fa.player.id)) {
        removedTopWaiverCandidates.push(fa);
      }
    }
  }

  // Determine if changes are significant
  const myStatusChanges = statusChanges.filter((sc) => sc.isMyPlayer);
  const significantWaiverChanges = newTopWaiverCandidates.length >= 3;
  const weekChanged = previous ? previous.week !== current.week : false;

  const significantChanges =
    myStatusChanges.length > 0 ||
    significantWaiverChanges ||
    weekChanged;

  return {
    statusChanges,
    newTopWaiverCandidates,
    removedTopWaiverCandidates,
    weekChanged,
    significantChanges,
  };
}
