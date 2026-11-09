"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Valued } from "./engine";
import type { Scouting, ScoutManager, ScoutPick } from "./espnLeague";
import { espnHeaders } from "./espnAuth";

const KEY = "cv.scouting";
const ORDER_KEY = "cv.draftOrder";

interface PlayerHistory { manager: ScoutManager; pick: ScoutPick }

interface ManagerProfile {
  manager: ScoutManager;
  seasons: number;
  /** Share of picks ESPN made for them (autodraft). High means their history says little. */
  autoShare: number;
  /** Positions they lean on in the first four rounds of their own picks. */
  earlyLean: string[];
  /** Players still in today's pool that they drafted before, most recent and earliest first. */
  favorites: { v: Valued; pick: ScoutPick }[];
}

interface Ctx {
  data: Scouting | null;
  loading: boolean;
  error: string | null;
  load: (leagueId: string, historyLeagueIds?: string) => Promise<void>;
  /** Your own draft order (slot -> ESPN owner id), overriding ESPN's until it's final. */
  order: Record<number, string> | null;
  setOrder: (o: Record<number, string> | null) => void;
  /** Set the order from the first round of a live ESPN draft (team ids in pick order). */
  setOrderFromTeams: (teamIds: number[]) => void;
  clear: () => void;
  /** Who drafted this player in past seasons (manual picks only). */
  historyOf: (playerId: number) => PlayerHistory[];
  /** The manager drafting from this 0-based slot this season, if known. */
  managerAtSlot: (slot: number) => ScoutManager | null;
}

const C = createContext<Ctx | null>(null);
export const useScouting = () => useContext(C);

export function ScoutingProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = useState<Scouting | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [order, setOrderState] = useState<Record<number, string> | null>(null);

  useEffect(() => {
    try {
      const s = localStorage.getItem(KEY); const d = s ? JSON.parse(s) : null;
      if (d && Array.isArray(d.managers)) setData(d);
      const o = localStorage.getItem(ORDER_KEY); const ord = o ? JSON.parse(o) : null;
      if (ord && typeof ord === "object" && !Array.isArray(ord)) setOrderState(ord);
    } catch { /* ignore */ }
  }, []);

  const setOrder = useCallback((o: Record<number, string> | null) => {
    setOrderState(o);
    try { if (o) localStorage.setItem(ORDER_KEY, JSON.stringify(o)); else localStorage.removeItem(ORDER_KEY); } catch { /* ignore */ }
  }, []);

  const setOrderFromTeams = useCallback((teamIds: number[]) => {
    if (!data) return;
    const next: Record<number, string> = {};
    teamIds.forEach((tid, i) => { const m = data.managers.find((x) => x.teamId === tid); if (m) next[i + 1] = m.ownerId; });
    if (Object.keys(next).length !== teamIds.length) return;
    if (order && Object.entries(next).every(([k, v]) => order[Number(k)] === v)) return;
    setOrder(next);
  }, [data, order, setOrder]);

  const load = useCallback(async (leagueId: string, historyLeagueIds?: string) => {
    setLoading(true); setError(null);
    try {
      const hist = (historyLeagueIds ?? "").split(",").map((x) => x.trim()).filter((x) => /^\d+$/.test(x)).join(",");
      const r = await fetch(
        `/api/scouting?leagueId=${encodeURIComponent(leagueId.trim())}${hist ? `&history=${hist}` : ""}`,
        { cache: "no-store", headers: espnHeaders() },
      );
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? r.statusText);
      setData(j);
      try { localStorage.setItem(KEY, JSON.stringify(j)); } catch { /* ignore */ }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const clear = useCallback(() => { setData(null); setOrder(null); try { localStorage.removeItem(KEY); } catch { /* ignore */ } }, [setOrder]);

  const index = useMemo(() => {
    const m = new Map<number, PlayerHistory[]>();
    for (const manager of data?.managers ?? []) {
      for (const pick of manager.picks) {
        if (pick.auto || pick.keeper) continue;
        (m.get(pick.playerId) ?? m.set(pick.playerId, []).get(pick.playerId)!).push({ manager, pick });
      }
    }
    for (const xs of m.values()) xs.sort((a, b) => b.pick.season - a.pick.season || a.pick.round - b.pick.round);
    return m;
  }, [data]);

  const value = useMemo<Ctx>(() => ({
    data, loading, error, load, clear, order, setOrder, setOrderFromTeams,
    historyOf: (id) => index.get(id) ?? [],
    managerAtSlot: (slot) => {
      const owner = order?.[slot + 1];
      if (owner) return data?.managers.find((m) => m.ownerId === owner) ?? null;
      return data?.managers.find((m) => m.slot === slot + 1) ?? null;
    },
  }), [data, loading, error, load, clear, order, setOrder, setOrderFromTeams, index]);

  return <C.Provider value={value}>{children}</C.Provider>;
}

/** What a manager's past drafts say about them. */
export function profileOf(manager: ScoutManager, byId: Map<number, Valued>): ManagerProfile {
  const seasons = new Set(manager.picks.map((p) => p.season)).size;
  const autoShare = manager.picks.length ? manager.picks.filter((p) => p.auto).length / manager.picks.length : 0;
  const counts: Record<string, number> = {};
  for (const p of manager.picks) {
    if (p.auto || p.round > 4) continue;
    const v = byId.get(p.playerId);
    for (const pos of v?.p.pos ?? []) counts[pos] = (counts[pos] ?? 0) + 1 / (v!.p.pos.length || 1);
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const earlyLean = Object.entries(counts).filter(([, n]) => total && n / total >= 0.3).sort((a, b) => b[1] - a[1]).map(([p]) => p);
  const favorites = manager.picks
    .filter((p) => !p.auto && byId.has(p.playerId))
    .sort((a, b) => b.season - a.season || a.round - b.round)
    .map((pick) => ({ v: byId.get(pick.playerId)!, pick }));
  return { manager, seasons, autoShare, earlyLean, favorites };
}

export const seasonLabel = (s: number) => `${s - 1}-${String(s).slice(2)}`;
