"use client";

import type { Valued, League } from "@/lib/engine";
import { TakeBadge } from "./Take";
import { usePlayerSheet } from "./playerSheetContext";
import { toggleAvoid, toggleStar, useAvoid, useStars } from "@/lib/stars";
import { headshotUrl, teamLogoUrl } from "@/lib/espnImages";

export const fmt = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : "–");

export function InjuryBadge({ s }: { s: string }) {
  if (!s || s === "ACTIVE") return null;
  const label = s === "DAY_TO_DAY" ? "DTD" : s === "OUT" ? "OUT" : s.slice(0, 3);
  const cls = s === "OUT" || s === "INJURY_RESERVE" ? "bg-red-500/20 text-red-700" : "bg-yellow-500/20 text-yellow-800";
  return <span className={`ml-1.5 rounded px-1 text-[10px] font-semibold ${cls}`}>{label}</span>;
}

const hideOnError = (e: React.SyntheticEvent<HTMLImageElement>) => { e.currentTarget.style.visibility = "hidden"; };

/** A placeholder bar or block while data loads. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`skeleton ${className}`} />;
}

/** Placeholder rows shaped like a player list: headshot, two lines of text, a number. */
export function SkeletonRows({ rows = 6, size = 32 }: { rows?: number; size?: number }) {
  return (
    <ul aria-hidden className="divide-y divide-line">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="flex items-center gap-3 py-2.5" style={{ opacity: 1 - i * (0.6 / rows) }}>
          <div className="skeleton shrink-0 rounded-full" style={{ width: size, height: size }} />
          <div className="flex-1 space-y-1.5">
            <div className="skeleton h-3" style={{ width: `${44 + ((i * 17) % 30)}%` }} />
            <div className="skeleton h-2.5 w-1/4" />
          </div>
          <div className="skeleton h-4 w-10" />
        </li>
      ))}
    </ul>
  );
}

/** Player headshot from ESPN (fantasy player ids are ESPN athlete ids). */
export function Headshot({ id, name, size = 32 }: { id: number; name: string; size?: number }) {
  return (
    <span
      className="inline-block shrink-0 overflow-hidden rounded-full border border-line bg-sunken"
      style={{ width: size, height: size }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={headshotUrl(id, size * 3, Math.round(size * 2.2))}
        alt={name}
        width={size}
        height={size}
        loading={size >= 64 ? "eager" : "lazy"}
        decoding="async"
        onError={hideOnError}
        // Fade in once loaded (cached images can finish before hydration, so check on mount too).
        ref={(img) => { if (img?.complete && img.naturalWidth) img.dataset.loaded = "1"; }}
        onLoad={(e) => { e.currentTarget.dataset.loaded = "1"; }}
        className="img-fade h-full w-full object-cover object-top"
      />
    </span>
  );
}

export function TeamLogo({ team, size = 14 }: { team: string; size?: number }) {
  if (!team || team === "FA") return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={teamLogoUrl(team, size * 3)}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={hideOnError}
      className="inline-block shrink-0"
      style={{ width: size, height: size }}
    />
  );
}

/** Star a player to track him as a target. A span, because it often sits inside a button. */
export function StarButton({ id, name, className = "" }: { id: number; name: string; className?: string }) {
  const on = useStars().has(id);
  const go = (e: React.SyntheticEvent) => { e.stopPropagation(); e.preventDefault(); toggleStar(id); };
  return (
    <span
      role="button"
      tabIndex={0}
      aria-pressed={on}
      aria-label={on ? `Unstar ${name}` : `Star ${name} as a target`}
      title={on ? "Remove from your targets" : "Add to your targets"}
      onClick={go}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") go(e); }}
      className={`inline-block cursor-pointer select-none leading-none ${on ? "text-amber-500" : "text-muted/40 hover:text-amber-500"} ${className}`}
    >
      {on ? "★" : "☆"}
    </span>
  );
}

/** Player name that opens the profile panel. A span, because it often sits inside a button. */
export function PlayerName({ v, className = "" }: { v: Valued; className?: string }) {
  const open = usePlayerSheet();
  if (!open) return <span className={className}>{v.p.name}</span>;
  const go = (e: React.SyntheticEvent) => { e.stopPropagation(); e.preventDefault(); open(v); };
  return (
    <span
      role="link"
      tabIndex={0}
      title={`${v.p.name}: notes, projection and news`}
      onClick={go}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") go(e); }}
      className={`cursor-pointer decoration-fg/30 underline-offset-2 hover:underline ${className}`}
    >
      {v.p.name}
    </span>
  );
}

/** Toggle a player onto your do-not-draft list. */
export function AvoidButton({ id, name }: { id: number; name: string }) {
  const on = useAvoid().has(id);
  return (
    <button
      onClick={(e) => { e.stopPropagation(); toggleAvoid(id); }}
      aria-pressed={on}
      className={on ? "rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1 text-xs font-medium text-red-700" : "btn-ghost"}
      title={on ? `Take ${name} off your do-not-draft list` : `Never recommend ${name}`}
    >
      {on ? "⊘ On your do-not-draft list" : "⊘ Do not draft"}
    </button>
  );
}

export function PlayerCell({ v }: { v: Valued }) {
  const avoided = useAvoid().has(v.p.id);
  return (
    <div className={`flex min-w-0 items-center gap-2.5 ${avoided ? "opacity-45" : ""}`} title={avoided ? "On your do-not-draft list" : undefined}>
      <Headshot id={v.p.id} name={v.p.name} />
      <div className="min-w-0">
        <div className="truncate font-medium">
          <StarButton id={v.p.id} name={v.p.name} className="mr-1" />
          <PlayerName v={v} />
          {avoided && <span className="ml-1.5 rounded border border-red-500/30 bg-red-500/10 px-1 text-[10px] font-semibold text-red-700">⊘ Avoid</span>}
          <InjuryBadge s={v.p.injury} />
          {v.take && <TakeBadge take={v.take} />}
        </div>
        <div className="flex items-center gap-1 text-[11px] text-muted">
          <TeamLogo team={v.p.team} />
          {v.p.team} · {v.p.pos.join("/")}
        </div>
      </div>
    </div>
  );
}

export function ValueCell({ v, league }: { v: Valued; league: League }) {
  return league.format === "points" ? (
    <span title="Projected season fantasy points (points per game × projected games). Rankings also credit a replacement for missed games and adjust for position scarcity.">
      {Math.round(v.total).toLocaleString()} <span className="text-muted text-[11px]">pts · {fmt(v.fppg)}/g</span>
    </span>
  ) : (
    <span title="Sum of category z-scores">{fmt(v.total, 2)} <span className="text-muted text-[11px]">z</span></span>
  );
}

export function ZChip({ z }: { z: number | undefined }) {
  const v = z ?? 0;
  const bg =
    v > 1.5 ? "bg-emerald-500/40" : v > 0.5 ? "bg-emerald-500/20" : v < -1.5 ? "bg-red-500/40" : v < -0.5 ? "bg-red-500/20" : "bg-fg/5";
  return <span className={`inline-block w-11 rounded text-center text-[11px] tabular-nums py-0.5 ${bg}`}>{fmt(v, 1)}</span>;
}

export function Card({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border border-line bg-panel shadow-[0_1px_2px_rgba(25,25,25,0.04)]">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <h2 className="text-sm font-medium tracking-tight text-fg">{title}</h2>
        {right}
      </div>
      <div className="p-3">{children}</div>
    </section>
  );
}

/** ESPN's own draft rank for the league's format. */
export const espnRankFor = (v: Valued, league: League) =>
  (league.format === "cats" ? v.p.espnRankRoto ?? v.p.espnRank : v.p.espnRank ?? v.p.espnRankRoto) ?? null;

export function VsEspn({ v, league }: { v: Valued; league: League }) {
  const r = espnRankFor(v, league);
  if (r == null) return <span className="text-muted">–</span>;
  const d = r - v.rank;
  const cls = d >= 8 ? "text-emerald-700" : d <= -8 ? "text-red-700" : "text-muted";
  return (
    <span className={`tabular-nums ${cls}`} title={`ESPN rank ${r}, our rank ${v.rank}`}>
      {r}
      {Math.abs(d) >= 3 && <span className="ml-1 text-[10px]">{d > 0 ? `▲${d}` : `▼${-d}`}</span>}
    </span>
  );
}
