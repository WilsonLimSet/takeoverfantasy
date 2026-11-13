// ESPN Fantasy Basketball Data Types

export type PlayerStatus =
  | 'ACTIVE'
  | 'DAY_TO_DAY'
  | 'OUT'
  | 'INJURY_RESERVE'
  | 'SUSPENSION'
  | 'DOUBTFUL'
  | 'QUESTIONABLE'
  | 'PROBABLE';

export type PositionId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;

export const POSITION_MAP: Record<PositionId, string> = {
  0: 'PG',
  1: 'SG',
  2: 'SF',
  3: 'PF',
  4: 'C',
  5: 'G',
  6: 'F',
  7: 'SG/SF',
  8: 'G/F',
  9: 'PF/C',
  10: 'F/C',
  11: 'UTIL',
};

export const LINEUP_SLOT_MAP: Record<number, string> = {
  0: 'PG',
  1: 'SG',
  2: 'SF',
  3: 'PF',
  4: 'C',
  5: 'G',
  6: 'F',
  7: 'SG/SF',
  8: 'G/F',
  9: 'PF/C',
  10: 'F/C',
  11: 'UTIL',
  12: 'BE', // Bench
  13: 'IR', // Injury Reserve
};

export interface ESPNPlayer {
  id: number;
  fullName: string;
  firstName: string;
  lastName: string;
  proTeamId: number;
  defaultPositionId: PositionId;
  eligibleSlots: number[];
  injured: boolean;
  injuryStatus?: PlayerStatus;
  ownership?: {
    percentOwned: number;
    percentChange: number;
    percentStarted: number;
  };
  stats?: ESPNPlayerStats[];
}

export interface ESPNPlayerStats {
  id: string; // e.g., "002025", "102025" for season/projected
  appliedTotal?: number;
  appliedAverage?: number;
  stats?: Record<string, number>;
  /** Per-game averages by stat id (40 = minutes). */
  averageStats?: Record<string, number>;
  proTeamId?: number;
  scoringPeriodId?: number;
  seasonId?: number;
  statSourceId?: number; // 0 = actual, 1 = projected
  statSplitTypeId?: number;
}

export interface ESPNRosterEntry {
  playerId: number;
  /** Set by us: picked up after today's lock, on the roster from this scoring period. */
  fromScoringPeriod?: number;
  playerPoolEntry?: {
    id: number;
    player: ESPNPlayer;
    appliedStatTotal?: number;
    ratings?: Record<string, { positionalRanking: number; totalRanking: number }>;
  };
  lineupSlotId: number;
  acquisitionDate: number;
  acquisitionType: string;
}

export interface ESPNTeam {
  id: number;
  abbrev: string;
  name: string;
  nickname?: string;
  owners?: string[];
  logo?: string;
  roster?: {
    entries: ESPNRosterEntry[];
  };
  record?: {
    overall: {
      wins: number;
      losses: number;
      ties: number;
      pointsFor: number;
      pointsAgainst: number;
    };
  };
  playoffSeed?: number;
  rankCalculatedFinal?: number;
  watchList?: number[]; // Player IDs the team owner is watching
  transactionCounter?: { acquisitions?: number; matchupAcquisitionTotals?: Record<string, number> };
}

export interface ESPNMatchup {
  id: number;
  matchupPeriodId: number;
  home: {
    teamId: number;
    totalPoints: number;
    totalPointsLive?: number;
    rosterForCurrentScoringPeriod?: {
      entries: ESPNRosterEntry[];
    };
  };
  away?: {
    teamId: number;
    totalPoints: number;
    totalPointsLive?: number;
    rosterForCurrentScoringPeriod?: {
      entries: ESPNRosterEntry[];
    };
  };
  winner?: 'HOME' | 'AWAY' | 'UNDECIDED';
}

export interface ESPNLeagueSettings {
  id: number;
  scoringPeriodId: number;
  currentMatchupPeriod: number;
  seasonId: number;
  name: string;
  size: number;
  status: {
    currentMatchupPeriod: number;
    isActive: boolean;
    latestScoringPeriod: number;
    previousSeasons: number[];
  };
  settings: {
    acquisitionSettings: {
      acquisitionLimit: number;
      acquisitionType: string;
      matchupAcquisitionLimit: number;
      /** When true, matchupAcquisitionLimit is per day and scales with the matchup's length. */
      matchupLimitPerScoringPeriod?: boolean;
    };
    rosterSettings: {
      lineupSlotCounts: Record<string, number>;
      positionLimits: Record<string, number>;
    };
    scheduleSettings: {
      matchupPeriodCount: number;
      matchupPeriodLength: number;
      matchupPeriods: Record<string, number[]>;
      playoffMatchupPeriodLength: number;
      playoffSeedingRule: string;
      playoffSeedingRuleBy: number;
      playoffTeamCount: number;
    };
    scoringSettings: {
      scoringType: string;
      playerRankType: string;
      matchupTieRule: string;
      matchupTieRuleBy: number;
      scoringItems: Array<{
        statId: number;
        pointsOverrides?: Record<string, number>;
        points: number;
        isReverseItem: boolean;
      }>;
    };
  };
}


// ESPN API Response types
export interface ESPNLeagueResponse {
  id: number;
  seasonId: number;
  scoringPeriodId: number;
  settings?: ESPNLeagueSettings['settings'];
  status?: ESPNLeagueSettings['status'];
  teams?: ESPNTeam[];
  schedule?: ESPNMatchup[];
  players?: Array<{
    id: number;
    player: ESPNPlayer;
    ratings?: Record<string, { positionalRanking: number; totalRanking: number }>;
  }>;
}

export interface ESPNFreeAgentResponse {
  players: Array<{
    id: number;
    player: ESPNPlayer;
    status: string;
    onTeamId?: number;
    ratings?: Record<string, { positionalRanking: number; totalRanking: number }>;
  }>;
  positionAgainstOpponent?: Record<string, unknown>;
}
