'use client';

import { Headshot, SkeletonRows, TeamLogo } from '@/components/ui';
import { isRoleDown as isDown, isRoleUp as isUp, type LeagueRotationEntry, type RotationKind, type RotationResponse } from '@/lib/rotationKinds';
import { Panel, ROTATION_URL, useCached } from './useMe';

const LABEL: Record<RotationKind, string> = {
  up: 'Minutes up',
  grown: 'Bigger role',
  opening: 'Injury opening',
  news: 'In the news',
  down: 'Minutes down',
  benched: 'Out of rotation',
};
const available = (e: LeagueRotationEntry) => e.where === 'free' || e.where === 'waivers';
const rank = (e: LeagueRotationEntry) => (e.fptsRecent || 0) + (e.kind === 'up' ? 6 : e.kind === 'grown' ? 4 : 0) + (e.because ? 0 : 3);

function Row({ e }: { e: LeagueRotationEntry }) {
  const down = isDown(e);
  return (
    <li className="flex gap-2.5 border-t border-line py-2.5 first:border-t-0">
      <Headshot id={e.id} name={e.name} size={32} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 text-sm">
          <span className="font-medium">{e.name}</span>
          <span className={`rounded px-1 text-[10px] font-semibold ${down ? 'bg-red-500/5 text-red-700' : 'bg-sunken text-fg'}`}>{LABEL[e.kind].toUpperCase()}</span>
          {e.where === 'waivers' && <span className="rounded bg-sunken px-1 text-[10px] font-semibold text-muted">WAIVERS</span>}
        </div>
        <div className="flex items-center gap-1 text-xs text-muted">
          <TeamLogo team={e.team} size={12} />
          <span className="truncate">
            {e.team} · {e.pos} · last 3: {e.recent.map((m) => (m > 0 ? Math.round(m) : 'DNP')).join(', ')} min
            {e.gamesLeft !== undefined ? ` · ${e.gamesLeft} left this wk` : ''}{e.gamesNext !== undefined ? `, ${e.gamesNext} next` : ''}
            {e.where === 'taken' && e.owner ? ` · on ${e.owner}` : ` · ${e.pctOwned}% rostered`}
          </span>
        </div>
        <p className="mt-0.5 text-xs">{e.note}</p>
      </div>
    </li>
  );
}

function Section({ title, rows, empty }: { title: string; rows: LeagueRotationEntry[]; empty?: string }) {
  if (!rows.length && !empty) return null;
  return (
    <div className="mt-4 first:mt-0">
      <h3 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">{title}</h3>
      {rows.length ? <ul>{rows.map((e) => <Row key={e.id} e={e} />)}</ul> : <p className="text-sm text-muted">{empty}</p>}
    </div>
  );
}

/**
 * Coaches' rotations from the last few box scores: who just got minutes (free in your league), who
 * gains while a teammate is out, and which of your players are losing theirs. compact: This week's
 * sidebar (your players plus the best few pickups).
 */
export function RotationPanel({ compact = false }: { compact?: boolean }) {
  const { data } = useCached<RotationResponse>(ROTATION_URL);
  // Hold its space while loading so the table below doesn't jump when it arrives.
  if (!data && !compact) return <Panel title="Rotation watch" className="mb-5"><SkeletonRows rows={4} /></Panel>;
  if (!data?.success || !data.entries) return null;
  const all = data.entries;
  const pickups = all.filter((e) => available(e) && isUp(e) && e.kind !== 'opening').sort((a, b) => rank(b) - rank(a));
  const openings = all.filter((e) => available(e) && e.kind === 'opening').sort((a, b) => (b.because?.minutes ?? 0) - (a.because?.minutes ?? 0));
  const mine = all.filter((e) => e.where === 'mine');
  const mineDown = mine.filter(isDown);
  const mineUp = mine.filter(isUp);
  const drops = all.filter((e) => !available(e) && e.where !== 'mine' && isDown(e)).sort((a, b) => b.pctOwned - a.pctOwned);
  const night = new Date(`${data.night}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

  if (compact) {
    if (!mineDown.length && !pickups.length) return null;
    return (
      <Panel title="Rotation watch" sub={`Minutes from the last 3 games, through ${night}.`}>
        <Section title="Your players losing minutes" rows={mineDown} />
        <Section title="Just got minutes, free in your league" rows={pickups.slice(0, 3)} />
        <a href="/inseason/waivers" className="mt-3 block text-xs text-muted underline hover:text-fg">All rotation changes</a>
      </Panel>
    );
  }
  return (
    <Panel
      title="Rotation watch"
      sub={`What coaches changed in the last 3 games (box scores through ${night}). Season averages lag a new role by weeks; these don’t. Injury-driven minutes say when the starter is due back.`}
      className="mb-5"
    >
      <Section title="Just got minutes · free in your league" rows={pickups.slice(0, 10)} empty="No free agent in your league has jumped in minutes lately." />
      <Section title="Injury openings · free in your league" rows={openings.slice(0, 8)} />
      <Section title="Your players" rows={[...mineDown, ...mineUp]} />
      {drops.length > 0 && (
        <details className="mt-4 border-t border-line pt-3">
          <summary className="cursor-pointer text-sm font-medium">Losing minutes on other teams ({drops.length})</summary>
          <ul className="mt-1">{drops.map((e) => <Row key={e.id} e={e} />)}</ul>
        </details>
      )}
    </Panel>
  );
}
