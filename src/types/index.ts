// Internal Data Models

import type { PlayerStatus } from './espn';

export * from './espn';

// Normalized player representation
export interface Player {
  id: number;
  name: string;
  firstName: string;
  lastName: string;
  nbaTeamId: number;
  nbaTeamAbbrev?: string;
  positions: string[];
  eligibleSlots: number[];
  status: PlayerStatus;
  injuryNote?: string;
  ownership?: {
    percentOwned: number;
    percentChange: number;
    percentStarted: number;
  };
  stats?: PlayerSeasonStats;
  /** His current role from the box scores (src/lib/value.ts `rotationOf`), added on refresh. */
  rotation?: PlayerRotation;
}

/** Minutes from recent games, and the minutes that lean on injured teammates. */
export interface PlayerRotation {
  /** Expected minutes a game now (recent games, coach's-decision DNPs as 0). */
  minutes: number;
  /** His recent points per minute over his season rate (1 = no change), blended half and half by 5 games. */
  rateScale?: number;
  /** Minutes in his recent games played (newest first), to rate his recent points in league scoring. */
  played?: number[];
  deps: {
    id: number;
    name: string;
    /** First US date the teammate is expected back. */
    until: string;
    /** Minutes a game he gains while the teammate is out. */
    minutes: number;
    /** Share of his recent games the teammate already missed (already in `minutes`). */
    absentShare: number;
  }[];
}

export interface PlayerSeasonStats {
  seasonAvg?: number;
  projectedAvg?: number;
  projectedTotal?: number;
  last7Avg?: number;
  last15Avg?: number;
  last30Avg?: number;
  gamesPlayed?: number;
  /** Minutes per game this season, and projected. */
  seasonMin?: number;
  projectedMin?: number;
}

// Roster entry with player details
export interface RosterEntry {
  playerId: number;
  player: Player;
  lineupSlot: string;
  lineupSlotId: number;
  acquisitionDate: number;
  appliedTotal?: number;
  /** Added after today's lock (ESPN applies it next scoring period): starts from this period. */
  fromPeriod?: number;
}

// Team with roster
export interface Team {
  id: number;
  abbrev: string;
  name: string;
  nickname?: string;
  isMyTeam: boolean;
  owners?: string[];
  record?: {
    wins: number;
    losses: number;
    ties: number;
    pointsFor: number;
    pointsAgainst: number;
  };
  roster?: RosterEntry[];
}

// Free agent entry
export interface FreeAgentEntry {
  player: Player;
  score: number;
  projectedPointsNext7?: number;
  gamesNext7?: number;
  recentTrend?: number;
  reasonCodes: string[];
  /** On waivers (claim clears later) rather than a free agent you can add right away. */
  onWaivers?: boolean;
}

// Matchup info
export interface Matchup {
  id: number;
  week: number;
  homeTeamId: number;
  awayTeamId?: number;
  homePoints: number;
  awayPoints?: number;
  isMyMatchup: boolean;
}

// NBA Schedule info
export interface NBATeamSchedule {
  teamId: number;
  teamAbbrev: string;
  gamesThisWeek: number;
  gamesNext7Days: number;
  gamesByDay: Record<string, boolean>; // date string -> has game
}

// Status change tracking
export interface StatusChange {
  playerId: number;
  playerName: string;
  previousStatus: PlayerStatus;
  currentStatus: PlayerStatus;
  isMyPlayer: boolean;
  injuryNote?: string;
  timestamp: number;
}

// Waiver recommendation
export interface WaiverRecommendation {
  rank: number;
  player: Player;
  score: number;
  projectedPointsNext7: number;
  gamesNext7: number;
  recentTrend: number;
  reasons: string[];
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}


// Injury opportunity
export interface InjuryOpportunity {
  injuredPlayer: Player;
  injuryStatus: PlayerStatus;
  injuryNote?: string;
  beneficiaries: Array<{
    player: Player;
    score: number;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    reasons: string[];
  }>;
  timestamp: number;
}

// Daily briefing
export interface DailyBriefing {
  generatedAt: number;
  week: number;
  myTeam: Team;
  statusChanges: StatusChange[];
  upcomingGames: Array<{
    player: Player;
    nextGameDate?: string;
    opponent?: string;
  }>;
  actionItems: string[];
  topWaiverAdds: WaiverRecommendation[];
  injuryOpportunities: InjuryOpportunity[];
  diffSummary: string[];
}

// League snapshot for persistence
export interface LeagueSnapshot {
  fetchedAt: number;
  leagueId: number;
  seasonId: number;
  week: number;
  scoringPeriodId: number;
  teams: Team[];
  myTeamId: number;
  matchups: Matchup[];
  freeAgentsTopN: FreeAgentEntry[];
  statusIndex: Record<number, { status: PlayerStatus; injuryNote?: string }>;
  scheduleIndex: Record<number, NBATeamSchedule>;
  /** The current matchup week: its days and which days each NBA team plays. */
  matchupWeek?: MatchupWeekSchedule;
  /** The matchup week after this one, so moves can show what they cost or add next week. */
  nextMatchupWeek?: MatchupWeekSchedule;
  /** Starting lineup spots (everything except bench and IR). */
  startingSlots?: number;
  /** ESPN lineup slot id -> how many the league has. */
  lineupSlots?: Record<string, number>;
  /** Pickups allowed this matchup (null = unlimited) and how many my team has used. */
  acquisitions?: { limit: number | null; used: number; /** Every team's pickups used this matchup, by team id. */ byTeam?: Record<number, number> };
  /** Points (H2H_POINTS etc.) or categories league. */
  scoringType?: string;
  /** ESPN's estimated return dates (YYYY-MM-DD) for injured players, by player id. */
  injuries?: Record<number, { returnDate?: string }>;
  /** Recent games' fantasy points under this league's scoring, by player id (gameLogs.ts). */
  gameLogs?: Record<number, GameLog>;
  /** A date (YYYY-MM-DD, US Eastern) whose NBA games were all final at fetch time. */
  dayDone?: string;
}

/** A player's recent games: this season as [scoringPeriodId, points], newest first; last season's points. */
export interface GameLog {
  cur: [number, number][];
  prev: number[];
}

export interface MatchupWeekSchedule {
  /** Every day of the matchup, in order. */
  days: Array<{ scoringPeriodId: number; date: string }>;
  /** NBA team id -> scoring periods this week the team plays. */
  teamGames: Record<number, number[]>;
}

export interface MatchupPlayerGames {
  playerId: number;
  name: string;
  nbaTeamAbbrev?: string;
  status: PlayerStatus;
  injured: boolean;
  games: number;
  gamesLeft: number;
  /** One flag per matchup day. */
  playsByDay: boolean[];
}

export interface MatchupSideGames {
  teamId: number;
  name: string;
  players: MatchupPlayerGames[];
  /** Players with a game each day (injured/IR players left out). */
  playingByDay: number[];
  totalGames: number;
  /** Players who can start each day once they're fitted into the lineup's position slots. */
  startableByDay: number[];
  /** Games that can count: each day's players fitted into the starting slots they're eligible for. */
  usableGames: number;
  gamesLeft: number;
}

export interface MatchupGamesComparison {
  week: number;
  days: Array<{ scoringPeriodId: number; date: string }>;
  /** NBA teams playing each day (0 on days without games). */
  teamsPlaying?: number[];
  /** Every NBA team's games this week (one flag per day) and games next matchup week. */
  teams?: Array<{ abbrev: string; byDay: boolean[]; next?: number }>;
  today: number;
  startingSlots: number;
  me: MatchupSideGames;
  opponent?: MatchupSideGames;
}

// Snapshot diff
export interface SnapshotDiff {
  statusChanges: StatusChange[];
  newTopWaiverCandidates: FreeAgentEntry[];
  removedTopWaiverCandidates: FreeAgentEntry[];
  weekChanged: boolean;
  significantChanges: boolean;
}

// Injury History Tracking
interface InjuryEvent {
  startDate: number;      // timestamp when injury started
  endDate?: number;       // timestamp when returned (undefined if still injured)
  status: PlayerStatus;   // OUT, IR, DTD, etc.
  note?: string;          // injury description
  gamesMissed: number;    // estimated games missed during this injury
}

export interface PlayerInjuryHistory {
  playerId: number;
  playerName: string;
  nbaTeamId: number;
  totalGamesMissed: number;       // total games missed this season
  totalGamesTracked: number;      // total games we've been tracking
  injuryEvents: InjuryEvent[];    // list of injury periods
  currentlyInjured: boolean;
  lastUpdated: number;
}

// Index of all players' injury histories
export type InjuryHistoryIndex = Record<number, PlayerInjuryHistory>;

// Injury risk assessment for waiver recommendations
export interface InjuryRiskAssessment {
  playerId: number;
  riskLevel: 'HIGH' | 'MEDIUM' | 'LOW';
  gamesMissedPct: number;         // % of games missed
  injuryCount: number;            // number of separate injury events
  isCurrentlyInjured: boolean;
  scorePenalty: number;           // multiplier (0.5-1.0) to apply to waiver score
}

// Watchlist for tracking players of interest
export interface Watchlist {
  /** Everything watched: the ESPN watchlist plus players added here. */
  playerIds: number[];
  lastUpdated: number;
  /** Players starred in ESPN at the last refresh (ESPN is the source of truth for these). */
  espnIds?: number[];
  /** Players added in our app; kept even when they're not on the ESPN watchlist. */
  appIds?: number[];
  /** ESPN-starred players removed here; hidden until they're un-starred in ESPN. */
  hiddenIds?: number[];
}

// Smart alert types for actionable notifications
export type SmartAlertType =
  | 'ROSTER_INJURY'           // Your player got injured
  | 'ROSTER_RETURN'           // Your player returned from injury
  | 'TEAMMATE_INJURY'         // Key teammate of your player is out (usage boost)
  | 'TEAMMATE_RETURN'         // Key teammate of your player is back (usage threat)
  | 'WATCHLIST_OPPORTUNITY'   // Key teammate of watchlist player is out
  | 'HOT_WAIVER_ADD'          // High-value waiver add available
  | 'WEEKLY_SUMMARY';         // Periodic summary

export interface SmartAlert {
  type: SmartAlertType;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  playerName?: string;
  teamAbbrev?: string;
  details: string;
  action?: string;              // Recommended action (e.g., "Add X, Drop Y")
  relatedPlayers?: string[];    // Players that benefit/are affected
  timestamp: number;
}


// League transaction (add/drop by other teams)
export interface LeagueTransaction {
  teamId: number;
  teamName?: string;
  type: 'ADD' | 'DROP' | 'TRADE';
  playerId: number;
  playerName?: string;
  playerSeasonAvg?: number;
  playerTeamAbbrev?: string;
  timestamp: number;
}
