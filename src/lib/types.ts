export type StatKey =
  | "pts" | "reb" | "ast" | "stl" | "blk" | "tov"
  | "fgm" | "fga" | "ftm" | "fta" | "tpm" | "tpa"
  | "oreb" | "dreb" | "min" | "dd" | "td";

/** Per-game stat line plus games played. */
export type StatLine = Record<StatKey, number> & { gp: number };

export type Pos = "PG" | "SG" | "SF" | "PF" | "C";

export interface PlayerBio {
  height: string | null; // e.g. 6' 11"
  weight: string | null; // e.g. 265 lbs
  years: number | null; // NBA seasons of experience
  jersey: string | null;
  college: string | null;
}

export interface Player {
  id: number;
  name: string;
  team: string;
  pos: Pos[];
  injury: string; // ACTIVE, OUT, DAY_TO_DAY, ...
  adp: number | null; // ESPN average draft position
  pctOwned: number | null;
  pctChange: number | null; // change in percent rostered over the last day
  espnRank: number | null; // ESPN STANDARD (points) draft rank
  espnRankRoto: number | null; // ESPN ROTO (categories) draft rank
  last: StatLine | null; // last season actual, per game
  proj: StatLine | null; // ESPN projection, per game
  cur: StatLine | null; // current season actual (in-season)
  age: number | null; // from ESPN team rosters; null when unknown (e.g. free agents)
  bio: PlayerBio | null;
  lastNews: number | null; // ms timestamp of the latest ESPN news item
}


export const STAT_KEYS: StatKey[] = [
  "pts", "reb", "ast", "stl", "blk", "tov", "fgm", "fga", "ftm", "fta",
  "tpm", "tpa", "oreb", "dreb", "min", "dd", "td",
];
