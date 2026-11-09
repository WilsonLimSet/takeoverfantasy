/** Rotation types and helpers, safe to import in the browser (rotation.ts reads the database). */

export type RotationKind = "up" | "opening" | "grown" | "down" | "benched" | "news";

export interface RotationEntry {
  id: number;
  name: string;
  team: string;
  pos: string;
  kind: RotationKind;
  /** Minutes in his last games he was available for, newest first (0 = coach's decision). */
  recent: number[];
  /** Minutes a game before that (the earlier games in the window, or the season if too few). */
  before: number;
  season: number;
  /** Fantasy points a game he played, last 3 vs before (ESPN standard scoring). */
  fptsRecent: number;
  fptsBefore: number;
  pctOwned: number;
  /** The injured teammate whose absence explains it, and when he's due back. */
  because?: { name: string; until: string; minutes: number };
  /** One line for the card. */
  note: string;
  /** The news behind a "news" entry. */
  headline?: string;
}

/** An entry placed in a user's league (/api/inseason/rotation). */
export type RotationWhere = "mine" | "free" | "waivers" | "taken";
export interface LeagueRotationEntry extends RotationEntry {
  where: RotationWhere;
  /** The fantasy team that has him, when taken. */
  owner?: string;
  gamesLeft?: number;
  gamesNext?: number;
}
export interface RotationResponse {
  success: boolean;
  night?: string;
  entries?: LeagueRotationEntry[];
  error?: string;
  needs?: string;
}

export interface RotationReport {
  /** The last night of box scores it's built from. */
  night: string;
  builtAt: number;
  entries: RotationEntry[];
}

export const isRoleUp = (e: RotationEntry) => e.kind === "up" || e.kind === "grown" || e.kind === "opening" || (e.kind === "news" && /^Role up/.test(e.note));
export const isRoleDown = (e: RotationEntry) => e.kind === "down" || e.kind === "benched" || (e.kind === "news" && /^Role down/.test(e.note));
