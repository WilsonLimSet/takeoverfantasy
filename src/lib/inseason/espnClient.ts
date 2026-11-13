/**
 * ESPN Fantasy Basketball API Client
 * Server-only module for authenticated ESPN API access
 *
 * SECURITY: Cookies are never logged. All secrets are server-side only.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type {
  ESPNLeagueResponse,
  ESPNFreeAgentResponse,
  ESPNTeam,
  ESPNMatchup,
  ESPNLeagueSettings,
} from '@/types/espn';

// ESPN API base URL
const ESPN_API_BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba';

// Rate limiting config
const RATE_LIMIT = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
};

// ESPN view parameters for different data fetches
const ESPN_VIEWS = {
  settings: 'mSettings',
  teams: 'mTeam',
  roster: 'mRoster',
  matchup: 'mMatchup',
  matchupScore: 'mMatchupScore',
  scoreboard: 'mScoreboard',
  schedule: 'mSchedule',
  status: 'mStatus',
  standings: 'mStandings',
  players: 'kona_player_info',
  pendingTransactions: 'mPendingTransactions',
  positionAgainstOpponent: 'kona_playercard',
} as const;

export interface ESPNClientConfig {
  leagueId: string;
  seasonId: number;
  /** ESPN login cookies; only needed for private leagues. */
  espnS2?: string;
  swid?: string;
}

interface FetchOptions {
  views?: string[];
  scoringPeriodId?: number;
  matchupPeriodId?: number;
  params?: Record<string, string>;
}

// A user's league for the duration of one call (see withLeague); the owner's env league otherwise.
const leagueScope = new AsyncLocalStorage<ESPNClientConfig>();

/** Run fn with every ESPN call in it pointed at this league. */
export function withLeague<T>(config: ESPNClientConfig, fn: () => Promise<T>): Promise<T> {
  return leagueScope.run(config, fn);
}

function getConfig(): ESPNClientConfig {
  const scoped = leagueScope.getStore();
  if (scoped) return scoped;

  const leagueId = process.env.ESPN_LEAGUE_ID;
  const seasonId = parseInt(process.env.ESPN_SEASON || '2026', 10);
  if (!leagueId) {
    throw new Error('ESPN_LEAGUE_ID environment variable is required');
  }
  return { leagueId, seasonId, espnS2: process.env.ESPN_S2, swid: process.env.ESPN_SWID };
}

/** Cookie header for the league's login, if it has one. SECURITY: never logged. */
function authHeaders(config: ESPNClientConfig): Record<string, string> {
  return config.espnS2 && config.swid ? { Cookie: `espn_s2=${config.espnS2}; SWID=${config.swid}` } : {};
}

export class ESPNHttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = RATE_LIMIT.maxRetries
): Promise<Response> {
  let lastError: Error | null = null;
  let delay = RATE_LIMIT.baseDelayMs;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, options);

      if (response.status === 429) {
        // Rate limited - back off
        console.warn(`ESPN API rate limited. Waiting ${delay}ms before retry...`);
        await sleep(delay);
        delay = Math.min(delay * 2, RATE_LIMIT.maxDelayMs);
        continue;
      }

      if (!response.ok) {
        const text = await response.text().catch(() => 'No response body');
        const err = new ESPNHttpError(response.status, `ESPN API error ${response.status}: ${text.substring(0, 200)}`);
        // A private league or a bad league id won't fix itself on retry.
        if (response.status >= 400 && response.status < 500) throw Object.assign(err, { final: true });
        throw err;
      }

      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if ((error as { final?: boolean }).final) throw error;
      if (attempt < retries) {
        console.warn(`ESPN API fetch failed (attempt ${attempt + 1}/${retries + 1}): ${lastError.message}`);
        await sleep(delay);
        delay = Math.min(delay * 2, RATE_LIMIT.maxDelayMs);
      }
    }
  }

  throw lastError || new Error('Failed to fetch from ESPN API');
}

async function espnFetch<T>(endpoint: string, options: FetchOptions = {}): Promise<T> {
  const config = getConfig();

  // Build URL with views and params
  const url = new URL(`${ESPN_API_BASE}/seasons/${config.seasonId}/segments/0/leagues/${config.leagueId}`);

  // Add views
  if (options.views && options.views.length > 0) {
    options.views.forEach((view) => url.searchParams.append('view', view));
  }

  // Add scoring period
  if (options.scoringPeriodId !== undefined) {
    url.searchParams.set('scoringPeriodId', String(options.scoringPeriodId));
  }

  // Add matchup period
  if (options.matchupPeriodId !== undefined) {
    url.searchParams.set('matchupPeriodId', String(options.matchupPeriodId));
  }

  // Add additional params
  if (options.params) {
    Object.entries(options.params).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
  }

  // SECURITY: Cookies are constructed here but never logged
  const response = await fetchWithRetry(url.toString(), {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      ...authHeaders(config),
    },
    cache: 'no-store',
  });

  return response.json() as Promise<T>;
}

async function espnFetchFreeAgents(options: {
  limit?: number;
  scoringPeriodId?: number;
  filter?: Record<string, unknown>;
}): Promise<ESPNFreeAgentResponse> {
  const config = getConfig();
  const limit = options.limit || 50;

  const url = new URL(`${ESPN_API_BASE}/seasons/${config.seasonId}/segments/0/leagues/${config.leagueId}`);
  url.searchParams.set('view', 'kona_player_info');

  if (options.scoringPeriodId !== undefined) {
    url.searchParams.set('scoringPeriodId', String(options.scoringPeriodId));
  }

  // Build filter for free agents
  const filter = {
    players: {
      filterStatus: {
        value: ['FREEAGENT', 'WAIVERS'],
      },
      filterSlotIds: {
        value: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      },
      sortPercOwned: {
        sortAsc: false,
        sortPriority: 1,
      },
      limit: limit,
      offset: 0,
      ...(options.filter || {}),
    },
  };

  const response = await fetchWithRetry(url.toString(), {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      ...authHeaders(config),
      'x-fantasy-filter': JSON.stringify(filter),
    },
    cache: 'no-store',
  });

  return response.json() as Promise<ESPNFreeAgentResponse>;
}

/**
 * Fetch players by specific IDs (for transaction player lookup)
 */
async function fetchPlayersByIds(playerIds: number[], _scoringPeriodId?: number): Promise<Map<number, {
  name: string;
  seasonAvg: number;
  teamAbbrev: string;
}>> {
  if (playerIds.length === 0) return new Map();

  const result = new Map<number, { name: string; seasonAvg: number; teamAbbrev: string }>();

  // Use ESPN's public athlete API (no auth needed, more reliable)
  const ESPN_ATHLETE_API = 'https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/athletes';

  // Fetch players in parallel (limit concurrency to avoid rate limits)
  const fetchPromises = playerIds.map(async (playerId) => {
    try {
      const response = await fetch(`${ESPN_ATHLETE_API}/${playerId}`, {
        cache: 'no-store',
      });

      if (!response.ok) return null;

      const data = await response.json() as {
        id: string;
        fullName: string;
        team?: { $ref: string };
      };

      // Extract team ID from $ref URL (e.g., ".../teams/5" -> 5)
      let teamId = 0;
      if (data.team?.$ref) {
        const teamMatch = data.team.$ref.match(/teams\/(\d+)/);
        if (teamMatch) teamId = parseInt(teamMatch[1], 10);
      }

      return {
        id: playerId,
        name: data.fullName,
        teamAbbrev: teamId ? (NBA_TEAMS[teamId]?.abbrev || '') : '',
      };
    } catch {
      return null;
    }
  });

  const results = await Promise.all(fetchPromises);

  for (const r of results) {
    if (r) {
      result.set(r.id, {
        name: r.name,
        seasonAvg: 0, // Public API doesn't have fantasy stats - fallback will fill this
        teamAbbrev: r.teamAbbrev,
      });
    }
  }

  console.log(`[fetchPlayersByIds] Fetched ${result.size}/${playerIds.length} players from ESPN public API`);

  return result;
}

// ============ Public API Functions ============

/**
 * Get league settings including scoring rules, roster settings, etc.
 */
async function getLeagueSettings(): Promise<ESPNLeagueSettings> {
  const response = await espnFetch<ESPNLeagueResponse>('', {
    views: [ESPN_VIEWS.settings, ESPN_VIEWS.status],
  });

  return {
    id: response.id,
    scoringPeriodId: response.scoringPeriodId,
    currentMatchupPeriod: response.status?.currentMatchupPeriod || 1,
    seasonId: response.seasonId,
    name: '', // Will be populated from teams
    size: response.settings?.rosterSettings?.lineupSlotCounts ? 8 : 8, // Default to 8
    status: response.status!,
    settings: response.settings!,
  };
}

/**
 * Get all teams in the league
 */
export async function getLeagueTeams(): Promise<ESPNTeam[]> {
  const response = await espnFetch<ESPNLeagueResponse>('', {
    views: [ESPN_VIEWS.teams, ESPN_VIEWS.standings],
  });

  return response.teams || [];
}

/** League name and teams with their managers, for picking "which team is mine". */
export async function getLeagueInfo(): Promise<{
  name: string;
  teams: Array<{ id: number; name: string; abbrev: string; owners: string[]; managers: string[] }>;
}> {
  const response = await espnFetch<ESPNLeagueResponse & {
    members?: Array<{ id: string; displayName?: string; firstName?: string; lastName?: string }>;
    settings?: { name?: string };
  }>('', { views: [ESPN_VIEWS.teams, ESPN_VIEWS.settings] });
  const members = new Map((response.members ?? []).map((m) => [m.id, m.displayName || `${m.firstName ?? ''} ${m.lastName ?? ''}`.trim()]));
  return {
    name: response.settings?.name ?? '',
    teams: (response.teams ?? []).map((t) => ({
      id: t.id,
      name: `${t.name || ''} ${t.nickname || ''}`.trim() || t.abbrev,
      abbrev: t.abbrev,
      owners: t.owners ?? [],
      managers: (t.owners ?? []).map((o) => members.get(o) ?? '').filter(Boolean),
    })),
  };
}

/**
 * Get rosters for all teams
 */
async function getLeagueRosters(scoringPeriodId?: number): Promise<ESPNTeam[]> {
  const response = await espnFetch<ESPNLeagueResponse>('', {
    views: [ESPN_VIEWS.roster, ESPN_VIEWS.teams],
    scoringPeriodId,
  });

  return response.teams || [];
}

/**
 * Rosters with moves already made: a manager who adds and drops after today's lock has that roster
 * from the next scoring period (ESPN's period roster still shows the old one). Players added for
 * then carry fromScoringPeriod so they don't count today; the rest of each team comes from today.
 */
function rosterAsOfNext(current: ESPNTeam[], next: ESPNTeam[], nextPeriod: number): ESPNTeam[] {
  const byId = new Map(next.map((t) => [t.id, t]));
  return current.map((t) => {
    const later = byId.get(t.id)?.roster?.entries;
    if (!later?.length || !t.roster) return t;
    const now = new Set(t.roster.entries.map((e) => e.playerId));
    const entries = later.map((e) => (now.has(e.playerId) ? e : { ...e, fromScoringPeriod: nextPeriod }));
    return { ...t, roster: { ...t.roster, entries } };
  });
}

/**
 * Get matchups for a specific week
 */
async function getMatchups(week?: number): Promise<ESPNMatchup[]> {
  const options: FetchOptions = {
    views: [ESPN_VIEWS.matchup, ESPN_VIEWS.matchupScore],
  };

  if (week !== undefined) {
    options.matchupPeriodId = week;
  }

  const response = await espnFetch<ESPNLeagueResponse>('', options);
  return response.schedule || [];
}

/**
 * Get top free agents
 */
async function getFreeAgents(params?: {
  limit?: number;
  scoringPeriodId?: number;
}): Promise<ESPNFreeAgentResponse> {
  return espnFetchFreeAgents({
    limit: params?.limit || 50,
    scoringPeriodId: params?.scoringPeriodId,
  });
}

/** The most rostered free agents and waiver players, healthy or not (for the injured stash list). */
export async function getFreeAgentPool(limit = 300, scoringPeriodId?: number): Promise<ESPNFreeAgentResponse> {
  return espnFetchFreeAgents({ limit, scoringPeriodId });
}

/**
 * Get NBA pro team schedule from ESPN
 */
async function getNBAProTeamSchedule(): Promise<Array<{
  id: number;
  abbrev: string;
  proGamesByScoringPeriod?: Record<string, Array<{ id: number; date: number }>>;
}>> {
  const config = getConfig();
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/${config.seasonId}?view=proTeamSchedules_wl`;

  try {
    const response = await fetchWithRetry(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        ...authHeaders(config),
      },
      cache: 'no-store',
    });

    const data = await response.json();
    return data.settings?.proTeams || [];
  } catch (error) {
    console.error('Failed to fetch NBA schedule:', error);
    return [];
  }
}

/**
 * Get recent league transactions (adds/drops by other teams)
 * Uses kona_league_communication view which contains ACTIVITY_TRANSACTIONS topics
 */
async function getRecentTransactions(): Promise<Array<{
  teamId: number;
  type: 'ADD' | 'DROP';
  playerId: number;
  timestamp: number;
}>> {
  try {
    const response = await espnFetch<{
      communication?: {
        topics?: Array<{
          type: string;
          date: number;
          messages?: Array<{
            targetId: number; // player ID
            to: number; // 11 = free agent, 12 = roster
            from: number; // 11 = free agent, 12 = roster
            for: number; // team ID that made the move
            date: number;
          }>;
        }>;
      };
    }>('', {
      views: ['kona_league_communication'],
    });

    const transactions: Array<{
      teamId: number;
      type: 'ADD' | 'DROP';
      playerId: number;
      timestamp: number;
    }> = [];

    // Look at recent transactions (last 12 hours to match cron interval)
    const twelveHoursAgo = Date.now() - 12 * 60 * 60 * 1000;

    for (const topic of response.communication?.topics || []) {
      if (topic.type !== 'ACTIVITY_TRANSACTIONS') continue;
      if (topic.date < twelveHoursAgo) continue;

      for (const msg of topic.messages || []) {
        // ESPN roster slot codes:
        // 0-10: Active roster slots (PG=0, SG=1, SF=2, PF=3, C=4, G=5, F=6, SG/SF=7, G/F=8, PF/C=9, UTIL=10)
        // 11: Free agent pool (FA/waivers)
        // 12: Bench slot
        // 13: IR slot
        //
        // A true DROP is: player moved TO free agent pool (to=11)
        // A true ADD is: player moved FROM free agent pool (from=11) to ANY roster slot
        const FREE_AGENT_SLOT = 11;

        // Skip messages without from/to (some ESPN messages don't have these)
        if (msg.from === undefined || msg.to === undefined) continue;

        // Skip internal roster moves (like slot 5 → slot 12, or IR → bench)
        // Only care about moves to/from free agent pool
        if (msg.from !== FREE_AGENT_SLOT && msg.to !== FREE_AGENT_SLOT) continue;

        if (msg.to === FREE_AGENT_SLOT && msg.from !== FREE_AGENT_SLOT) {
          // DROP: player moved from any roster slot to free agent pool
          transactions.push({
            teamId: msg.for,
            type: 'DROP',
            playerId: msg.targetId,
            timestamp: msg.date,
          });
        } else if (msg.from === FREE_AGENT_SLOT && msg.to !== FREE_AGENT_SLOT) {
          // ADD: player moved from free agent pool to any roster slot
          transactions.push({
            teamId: msg.for,
            type: 'ADD',
            playerId: msg.targetId,
            timestamp: msg.date,
          });
        }
      }
    }

    // Return all transactions - validation against current roster state
    // is done in getLeagueSnapshot() to filter out phantom transactions
    return transactions;
  } catch (error) {
    console.error('Failed to fetch transactions:', error);
    return [];
  }
}


/**
 * Get combined league snapshot with all necessary data including NBA schedule
 */
export async function getLeagueSnapshot(): Promise<{
  settings: ESPNLeagueSettings;
  teams: ESPNTeam[];
  matchups: ESPNMatchup[];
  freeAgents: ESPNFreeAgentResponse;
  nbaSchedule: Array<{
    id: number;
    abbrev: string;
    proGamesByScoringPeriod?: Record<string, Array<{ id: number; date: number }>>;
  }>;
  recentTransactions: Array<{
    teamId: number;
    type: 'ADD' | 'DROP';
    playerId: number;
    playerName?: string;
    playerSeasonAvg?: number;
    playerTeamAbbrev?: string;
    timestamp: number;
  }>;
}> {
  // Fetch settings first to get current scoring period
  const settings = await getLeagueSettings();
  const scoringPeriodId = settings.scoringPeriodId;

  // Fetch remaining data in parallel
  const [current, next, matchups, freeAgents, nbaSchedule, rawTransactions] = await Promise.all([
    getLeagueRosters(scoringPeriodId),
    // Adds and drops made after today's lock show up only from the next scoring period.
    getLeagueRosters(scoringPeriodId + 1).catch(() => [] as ESPNTeam[]),
    getMatchups(settings.currentMatchupPeriod),
    // Deep enough to reach bench players who pick up minutes when a teammate is out.
    getFreeAgents({ limit: 250, scoringPeriodId }),
    getNBAProTeamSchedule(),
    getRecentTransactions(),
  ]);
  const teams = rosterAsOfNext(current, next, scoringPeriodId + 1);

  // Watchlisted players are often deeper than the top free agents, so fetch them by id too.
  const watchIds = [...new Set(teams.flatMap((t) => t.watchList ?? []))];
  if (watchIds.length) {
    try {
      const watched = await espnFetchFreeAgents({
        limit: watchIds.length,
        scoringPeriodId,
        filter: { filterIds: { value: watchIds } },
      });
      const have = new Set(freeAgents.players.map((p) => p.id));
      freeAgents.players.push(...(watched.players ?? []).filter((p) => !have.has(p.id)));
    } catch (e) {
      console.warn('Watchlist player fetch failed:', e instanceof Error ? e.message : e);
    }
  }

  // Build a player lookup map from rosters and free agents (which have full stats)
  const playerLookup = new Map<number, { name: string; seasonAvg: number; teamAbbrev: string }>();

  // Build a map of which players are on which team's roster (for validating transactions)
  // Key: "playerId-teamId", Value: true if player is on that team's roster
  const rosterState = new Map<string, boolean>();

  // Add players from all team rosters (for recently added players)
  const currentSeasonId = `00${settings.seasonId}`; // e.g., "002026" for season stats

  for (const team of teams) {
    for (const entry of team.roster?.entries || []) {
      const player = entry.playerPoolEntry?.player;
      if (player) {
        // Track that this player is on this team's roster
        rosterState.set(`${player.id}-${team.id}`, true);

        // Extract season average from stats
        // statSourceId: 0 = actual stats, id format: "00YYYY" = season, "01YYYY" = last 7 days, etc.
        let seasonAvg = 0;
        for (const stat of player.stats || []) {
          // Look for current season actual stats (e.g., "002026")
          if (stat.statSourceId === 0 && stat.id === currentSeasonId && stat.appliedAverage !== undefined) {
            seasonAvg = stat.appliedAverage;
            break;
          }
        }
        playerLookup.set(player.id, {
          name: player.fullName,
          seasonAvg,
          teamAbbrev: NBA_TEAMS[player.proTeamId]?.abbrev || '',
        });
      }
    }
  }

  // Add players from free agents (for recently dropped players)
  for (const fa of freeAgents.players || []) {
    const player = fa.player;
    if (player && !playerLookup.has(player.id)) {
      let seasonAvg = 0;
      for (const stat of player.stats || []) {
        // Look for current season actual stats (e.g., "002026")
        if (stat.statSourceId === 0 && stat.id === currentSeasonId && stat.appliedAverage !== undefined) {
          seasonAvg = stat.appliedAverage;
          break;
        }
      }
      playerLookup.set(player.id, {
        name: player.fullName,
        seasonAvg,
        teamAbbrev: NBA_TEAMS[player.proTeamId]?.abbrev || '',
      });
    }
  }

  // For any players not found in rosters/FA, fall back to public API for name only
  const missingPlayerIds = rawTransactions
    .map(tx => tx.playerId)
    .filter(id => !playerLookup.has(id));

  if (missingPlayerIds.length > 0) {
    const fallbackInfo = await fetchPlayersByIds(missingPlayerIds, scoringPeriodId);
    for (const [id, info] of fallbackInfo) {
      if (!playerLookup.has(id)) {
        playerLookup.set(id, info);
      }
    }
  }

  // Validate transactions against current roster state to filter out phantom transactions
  // ESPN's batch processing can create phantom DROPs for players still on roster
  const validatedTransactions = rawTransactions.filter(tx => {
    const rosterKey = `${tx.playerId}-${tx.teamId}`;
    const isOnRoster = rosterState.has(rosterKey);

    if (tx.type === 'DROP') {
      // If player is still on the team's roster, this is a phantom DROP - ignore it
      if (isOnRoster) {
        return false;
      }
    } else if (tx.type === 'ADD') {
      // If player is NOT on the team's roster, this is a phantom ADD - ignore it
      if (!isOnRoster) {
        return false;
      }
    }
    return true;
  });

  const recentTransactions = validatedTransactions.map(tx => {
    const playerInfo = playerLookup.get(tx.playerId);
    return {
      ...tx,
      playerName: playerInfo?.name,
      playerSeasonAvg: playerInfo?.seasonAvg,
      playerTeamAbbrev: playerInfo?.teamAbbrev,
    };
  });

  return {
    settings,
    teams,
    matchups,
    freeAgents,
    nbaSchedule,
    recentTransactions,
  };
}


// ============ NBA Team Reference Data ============

export const NBA_TEAMS: Record<number, { abbrev: string; name: string }> = {
  1: { abbrev: 'ATL', name: 'Atlanta Hawks' },
  2: { abbrev: 'BOS', name: 'Boston Celtics' },
  3: { abbrev: 'NOP', name: 'New Orleans Pelicans' },
  4: { abbrev: 'CHI', name: 'Chicago Bulls' },
  5: { abbrev: 'CLE', name: 'Cleveland Cavaliers' },
  6: { abbrev: 'DAL', name: 'Dallas Mavericks' },
  7: { abbrev: 'DEN', name: 'Denver Nuggets' },
  8: { abbrev: 'DET', name: 'Detroit Pistons' },
  9: { abbrev: 'GSW', name: 'Golden State Warriors' },
  10: { abbrev: 'HOU', name: 'Houston Rockets' },
  11: { abbrev: 'IND', name: 'Indiana Pacers' },
  12: { abbrev: 'LAC', name: 'LA Clippers' },
  13: { abbrev: 'LAL', name: 'Los Angeles Lakers' },
  14: { abbrev: 'MIA', name: 'Miami Heat' },
  15: { abbrev: 'MIL', name: 'Milwaukee Bucks' },
  16: { abbrev: 'MIN', name: 'Minnesota Timberwolves' },
  17: { abbrev: 'BKN', name: 'Brooklyn Nets' },
  18: { abbrev: 'NYK', name: 'New York Knicks' },
  19: { abbrev: 'ORL', name: 'Orlando Magic' },
  20: { abbrev: 'PHI', name: 'Philadelphia 76ers' },
  21: { abbrev: 'PHX', name: 'Phoenix Suns' },
  22: { abbrev: 'POR', name: 'Portland Trail Blazers' },
  23: { abbrev: 'SAC', name: 'Sacramento Kings' },
  24: { abbrev: 'SAS', name: 'San Antonio Spurs' },
  25: { abbrev: 'OKC', name: 'Oklahoma City Thunder' },
  26: { abbrev: 'UTA', name: 'Utah Jazz' },
  27: { abbrev: 'WAS', name: 'Washington Wizards' },
  28: { abbrev: 'TOR', name: 'Toronto Raptors' },
  29: { abbrev: 'MEM', name: 'Memphis Grizzlies' },
  30: { abbrev: 'CHA', name: 'Charlotte Hornets' },
};
