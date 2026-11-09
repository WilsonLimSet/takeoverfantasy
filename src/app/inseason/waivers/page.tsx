'use client';

import { useState } from 'react';
import { Headshot, InjuryBadge, TeamLogo } from '@/components/ui';
import type { MovesResponse } from '../MovesPanel';
import { Gate, isGated, Loading, MOVES_URL, Panel, useCached } from '../useMe';
import { RotationPanel } from '../RotationPanel';

/** Free agents ranked by what each would add to this week's lineup, not just by projection. */
export default function FreeAgentsPage() {
  const { data } = useCached<MovesResponse>(MOVES_URL);
  const [hideWaivers, setHideWaivers] = useState(false);

  if (!data) return <Loading what="free agents" />;
  if (isGated(data.needs)) return <Gate needs={data.needs} />;
  if (!data.plan) return <Panel title="Free agents"><p className="text-sm text-muted">{data.error ?? 'No league data yet.'}</p></Panel>;

  const rows = data.plan.freeAgents.filter((f) => !hideWaivers || !f.player.onWaivers);
  return (
    <>
    <RotationPanel />
    <Panel
      title="Free agents"
      sub={`Ranked by the points each adds to your lineup over the ${data.plan.daysLeft} days left, swapped for your weakest streaming spot.`}
      right={
        <label className="flex cursor-pointer items-center gap-1.5">
          <input type="checkbox" checked={hideWaivers} onChange={(e) => setHideWaivers(e.target.checked)} />
          Free agents only (no waiver claims)
        </label>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
              <th className="pb-2 font-medium">Player</th>
              <th className="pb-2 pl-2 text-right font-medium" title="Games left this week">Left</th>
              <th className="hidden pb-2 pl-2 text-right font-medium sm:table-cell" title="Games he'd start in your lineup">Starts</th>
              <th className="pb-2 pl-2 text-right font-medium" title="Games next matchup week">Next</th>
              <th className="hidden pb-2 pl-2 text-right font-medium sm:table-cell">Pts/g</th>
              <th className="hidden pb-2 pl-2 text-right font-medium sm:table-cell">Owned</th>
              <th className="pb-2 pl-2 text-right font-medium" title="Projected points his best swap adds this week"><span className="sm:hidden">Adds</span><span className="hidden sm:inline">Proj adds</span></th>
              <th className="hidden pb-2 pl-4 font-medium sm:table-cell">Drop</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.player.id} className="border-t border-line">
                <td className="max-w-[10rem] py-2 pr-2 sm:max-w-none">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Headshot id={f.player.id} name={f.player.name} size={28} />
                    <div className="min-w-0">
                      <div className="truncate">
                        {f.player.name}
                        <InjuryBadge s={f.player.status} />
                        {f.player.onWaivers && <span className="ml-1.5 rounded bg-sunken px-1 text-[10px] font-semibold text-muted">WAIVERS</span>}
                      </div>
                      <div className="flex min-w-0 items-center gap-1 text-xs text-muted">
                        {f.player.nbaTeamAbbrev && <TeamLogo team={f.player.nbaTeamAbbrev} size={12} />}
                        <span className="truncate">
                          {f.player.nbaTeamAbbrev} · {f.player.positions.join('/')}
                          <span className="sm:hidden"> · {f.player.fppg}/g</span>
                        </span>
                      </div>
                      {f.player.opportunity && <div className="truncate text-xs text-fg">{f.player.opportunity}</div>}
                    </div>
                  </div>
                </td>
                <td className={`py-2 text-right tabular-nums ${f.player.gamesLeft >= 4 ? 'font-medium text-accent' : ''}`}>{f.player.gamesLeft}</td>
                <td className="hidden py-2 text-right tabular-nums sm:table-cell">{f.player.usableLeft}</td>
                <td className={`py-2 text-right tabular-nums ${(f.player.gamesNext ?? 0) >= 4 ? 'font-medium text-accent' : 'text-muted'}`}>{f.player.gamesNext ?? '–'}</td>
                <td className="hidden py-2 text-right tabular-nums sm:table-cell">{f.player.fppg}</td>
                <td className="hidden py-2 text-right tabular-nums text-muted sm:table-cell">{f.player.percentOwned !== undefined ? `${Math.round(f.player.percentOwned)}%` : '–'}</td>
                <td className="py-2 text-right font-medium tabular-nums">{f.pointsGain > 0 ? `+${Math.round(f.pointsGain)}` : <span className="font-normal text-muted">–</span>}</td>
                <td className="hidden max-w-[10rem] truncate py-2 pl-4 text-muted sm:table-cell">{f.dropFor ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
    </>
  );
}
