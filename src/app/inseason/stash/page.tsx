'use client';

import { useState } from 'react';
import { Headshot, InjuryBadge, TeamLogo } from '@/components/ui';
import type { StashList, StashPlayer } from '@/lib/inseason/stash';
import { Gate, isGated, Loading, Panel, useCached } from '../useMe';

type StashResponse = Partial<StashList> & { success: boolean; error?: string; needs?: 'signin' | 'pro' | 'connect' };

const shortDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function Timeline({ p }: { p: StashPlayer }) {
  if (!p.returnDate) return <span className="text-muted">No timeline</span>;
  const season = p.returnDate >= '2027-06-01';
  return (
    <span>
      {season ? 'Out for the season' : <>Back ~{shortDate(p.returnDate)}{p.daysOut !== undefined && <span className="text-muted"> · {p.daysOut}d</span>}</>}
      {p.timelineShift && !season && (
        <span className={`ml-1.5 rounded px-1 text-[10px] font-semibold ${p.timelineShift.days > 0 ? 'bg-red-500/10 text-red-700' : 'bg-accent/10 text-accent'}`}>
          {p.timelineShift.days > 0 ? `+${p.timelineShift.days}d later` : `${-p.timelineShift.days}d sooner`}
        </span>
      )}
    </span>
  );
}

function Row({ p }: { p: StashPlayer }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-t border-line py-3 first:border-t-0 first:pt-0">
      <button onClick={() => setOpen(!open)} className="grid w-full grid-cols-[1fr_auto] items-start gap-3 text-left">
        <div className="flex min-w-0 items-start gap-2.5">
          <Headshot id={p.id} name={p.name} size={32} />
          <div className="min-w-0">
            <div className="truncate text-sm">
              <span className="font-medium">{p.name}</span>
              <InjuryBadge s={p.status} />
              {p.onWaivers && <span className="ml-1.5 rounded bg-sunken px-1 text-[10px] font-semibold text-muted">WAIVERS</span>}
            </div>
            <div className="flex min-w-0 items-center gap-1 text-xs text-muted">
              {p.nbaTeamAbbrev && <TeamLogo team={p.nbaTeamAbbrev} size={12} />}
              <span className="truncate">
                {p.nbaTeamAbbrev} · {p.positions.join('/')}{p.injury ? ` · ${p.injury}` : ''}
                {p.percentOwned !== undefined ? ` · ${Math.round(p.percentOwned)}% rostered` : ''}
              </span>
            </div>
            <div className="mt-1 text-xs"><Timeline p={p} /></div>
          </div>
        </div>
        <div className="text-right">
          <div className={`text-sm font-medium tabular-nums ${p.beatsWeakest ? 'text-accent' : ''}`}>{p.fppg}</div>
          <div className="text-[11px] text-muted">pts/g when back</div>
        </div>
      </button>
      {p.note && (
        <div className="mt-2 pl-[42px] text-xs text-muted">
          <p>{p.note}</p>
          {open && p.detail && <p className="mt-1.5">{p.detail}</p>}
          <p className="mt-1 text-[11px]">
            Updated {new Date(p.noteAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            {p.detail && !open && <> · <span className="underline underline-offset-2">more</span></>}
          </p>
        </div>
      )}
    </li>
  );
}

/** Free agents who are out now but worth stashing for when they're healthy. */
export default function StashPage() {
  const { data } = useCached<StashResponse>('/api/inseason/stash');
  if (!data) return <Loading what="injured free agents" />;
  if (isGated(data.needs)) return <Gate needs={data.needs} />;
  if (!data.players) return <Panel title="Injured stash"><p className="text-sm text-muted">{data.error ?? 'No data yet.'}</p></Panel>;

  const soon = data.players.filter((p) => !p.longTerm);
  const later = data.players.filter((p) => p.longTerm);
  const weakest = data.weakest ? `Green = better per game than ${data.weakest.name} (${data.weakest.fppg}), your weakest healthy player.` : '';
  return (
    <div className="space-y-4">
      <Panel
        title={`Back within ${data.windowDays} days`}
        sub={`Injured free agents in your league, by what they score when healthy. Return dates are ESPN's estimates; we flag when one moves. ${weakest}`}
      >
        {soon.length ? <ul>{soon.map((p) => <Row key={p.id} p={p} />)}</ul> : <p className="text-sm text-muted">Nobody worth stashing is due back soon.</p>}
      </Panel>
      {later.length > 0 && (
        <Panel title="Longer term" sub="Out more than six weeks, for the season, or no timeline yet.">
          <ul>{later.map((p) => <Row key={p.id} p={p} />)}</ul>
        </Panel>
      )}
    </div>
  );
}
