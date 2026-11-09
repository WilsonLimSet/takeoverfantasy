'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Headshot, InjuryBadge, TeamLogo } from '@/components/ui';
import type { TradeFinder, TradeIdea, TradePlayer } from '@/lib/trades';
import { Gate, isGated, Loading, Panel, useCached } from '../useMe';

type TradesResponse = Partial<TradeFinder> & {
  success: boolean;
  error?: string;
  needs?: 'signin' | 'pro' | 'connect';
  leagueId?: number;
  seasonId?: number;
  block?: number[];
};

function Names({ ps }: { ps: TradePlayer[] }) {
  return (
    <>
      {ps.map((p, i) => (
        <span key={p.id} className="whitespace-nowrap">
          {i > 0 && <span className="text-muted"> + </span>}
          <span className="font-medium">{p.name}</span>
          <span className="ml-1 inline-block align-[-2px]"><TeamLogo team={p.team} size={14} /></span>
        </span>
      ))}
    </>
  );
}
const checkUrl = (x: TradeIdea) => `/trade?give=${x.give.map((p) => p.id).join(',')}&get=${x.get.map((p) => p.id).join(',')}`;

function Faces({ ps }: { ps: TradePlayer[] }) {
  return (
    <div className="flex -space-x-2">
      {ps.map((p) => <Headshot key={p.id} id={p.id} name={p.name} size={32} />)}
    </div>
  );
}

function Idea({ x, espn }: { x: TradeIdea; espn?: string }) {
  return (
    <li className="border-t border-line py-4 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">To {x.teamName}</div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <div className="flex items-center gap-2.5">
              <Faces ps={x.give} />
              <div className="min-w-0 text-sm">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-red-700">Give</span>{' '}
                <Names ps={x.give} />
              </div>
            </div>
            <div className="flex items-center gap-2.5">
              <Faces ps={x.get} />
              <div className="min-w-0 text-sm">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-accent">Get</span>{' '}
                <Names ps={x.get} />
              </div>
            </div>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-lg font-medium tabular-nums tracking-tight text-accent">+{x.gain}</div>
          <div className="text-[11px] uppercase tracking-wide text-muted">pts/game</div>
        </div>
      </div>
      <ul className="mt-2 space-y-0.5 text-xs text-muted">
        {x.why.map((w) => <li key={w}>· {w}</li>)}
      </ul>
      <div className="mt-2.5 flex flex-wrap gap-2">
        {espn && <a href={espn} target="_blank" rel="noopener noreferrer" className="btn-accent">Propose on ESPN</a>}
        <Link href={checkUrl(x)} className="btn-ghost">Full breakdown</Link>
      </div>
    </li>
  );
}

function FormRow({ p, sub }: { p: TradePlayer; sub?: string }) {
  return (
    <li className="flex items-center gap-2.5 border-t border-line py-2 first:border-t-0">
      <Headshot id={p.id} name={p.name} size={28} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{p.name}<InjuryBadge s={p.status} /></div>
        <div className="flex items-center gap-1 truncate text-xs text-muted"><TeamLogo team={p.team} size={12} /><span className="truncate">{sub ? `${sub} · ` : ''}{p.team} · {p.pos}</span></div>
      </div>
      <div className="text-right text-xs">
        <div className="tabular-nums"><span className="font-medium text-fg">{p.recent}</span> <span className="text-muted">lately</span></div>
        <div className="tabular-nums text-muted">{p.perGame} expected</div>
      </div>
    </li>
  );
}

/**
 * Your trade block: the players you're open to trading. Offers only send these (none picked:
 * anyone). Saved to your account; the offers rebuild when you apply a change.
 */
function TradeBlock({ roster, saved, onSaved }: { roster: TradePlayer[]; saved: number[]; onSaved: () => Promise<void> }) {
  const [picked, setPicked] = useState<number[]>(saved);
  const [busy, setBusy] = useState(false);
  const dirty = picked.length !== saved.length || picked.some((id) => !saved.includes(id));
  const toggle = (id: number) => setPicked((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));
  const apply = async (block: number[]) => {
    setBusy(true);
    try {
      await fetch('/api/inseason/trades', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ block }) });
      setPicked(block);
      await onSaved();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel
      title="Your trade block"
      sub={saved.length ? `Offers only send these ${saved.length}. Tap to change.` : 'Tap the players you’re open to trading. None picked: offers can send anyone.'}
      right={picked.length > 0 && !busy ? <button onClick={() => apply([])} className="btn-ghost">Clear</button> : undefined}
      className="mb-5"
    >
      <div className="flex flex-wrap gap-2">
        {roster.map((p) => {
          const on = picked.includes(p.id);
          return (
            <button
              key={p.id}
              onClick={() => toggle(p.id)}
              disabled={busy}
              aria-pressed={on}
              className={`flex items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-sm transition-colors disabled:opacity-60 ${on ? 'border-ink bg-ink text-white' : 'border-line bg-panel hover:border-fg/30'}`}
            >
              <Headshot id={p.id} name={p.name} size={24} />
              <span className="font-medium">{p.name}</span>
              <span className={`text-xs tabular-nums ${on ? 'text-white/70' : 'text-muted'}`}>{p.ros}</span>
            </button>
          );
        })}
      </div>
      {(dirty || busy) && (
        <button onClick={() => apply(picked)} disabled={busy} className="btn-accent mt-4 inline-flex items-center gap-2">
          {busy && <span aria-hidden className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />}
          {busy ? 'Finding offers…' : picked.length ? `Find offers for these ${picked.length}` : 'Find offers for anyone'}
        </button>
      )}
    </Panel>
  );
}

/** Trade ideas for your league: buy low on slumps, sell high on hot streaks, health counted. */
export default function TradesPage() {
  const { data, reload } = useCached<TradesResponse>('/api/inseason/trades');
  if (!data) return <Loading what="trade ideas" />;
  if (isGated(data.needs)) return <Gate needs={data.needs} />;
  if (!data.success || !data.ideas) return <Panel title="Trades"><p className="text-sm text-muted">{data.error ?? 'No data yet.'}</p></Panel>;
  const espn = (teamId: number) =>
    data.leagueId ? `https://fantasy.espn.com/basketball/team?leagueId=${data.leagueId}&teamId=${teamId}${data.seasonId ? `&seasonId=${data.seasonId}` : ''}` : undefined;

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-3xl font-medium leading-tight tracking-[-0.03em]">Trades</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Offers that win for you on rest-of-season points per game (games they&apos;ll miss counted) and look fair to the other manager on
          recent box scores. Buy stars in a slump, sell players running hot. We never suggest trading for someone who&apos;s out long or sits often.
        </p>
      </div>
      {(data.roster?.length ?? 0) > 0 && <TradeBlock key={(data.block ?? []).join(',')} roster={data.roster!} saved={data.block ?? []} onSaved={reload} />}
      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <Panel
          title="Offers to make"
          sub="Best first. The gain is what your team adds per game, the rest of the season."
          right={<Link href="/trade" className="btn-ghost">Check any trade</Link>}
        >
          {data.ideas.length ? (
            <ul>{data.ideas.map((x) => <Idea key={`${x.teamId}:${[...x.give, ...x.get].map((p) => p.id).join(',')}`} x={x} espn={espn(x.teamId)} />)}</ul>
          ) : (
            <p className="text-sm text-muted">{data.block?.length ? 'No offer using just your trade block beats your roster right now. Add players to the block, or check back after a few games.' : 'No trade beats your roster right now that the other side would take. Check back after a few games: slumps open windows.'}</p>
          )}
        </Panel>
        <div className="space-y-5">
          {(data.buyLow?.length ?? 0) > 0 && (
            <Panel title="Buy low" sub="League mates' players playing below their role. Ask about them now.">
              <ul className="-my-1">{data.buyLow!.map((p) => <FormRow key={p.id} p={p} sub={p.teamName} />)}</ul>
            </Panel>
          )}
          <Panel title="Sell high" sub="Your players worth more to other managers than to you. Shop them now.">
            {(data.sellHigh?.length ?? 0) > 0 ? (
              <ul className="-my-1">
                {data.sellHigh!.map((p) => (
                  <li key={p.id} className="border-t border-line py-2 first:border-t-0">
                    <div className="flex items-center gap-2.5">
                      <Headshot id={p.id} name={p.name} size={28} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm">{p.name}<InjuryBadge s={p.status} /></div>
                        <div className="flex items-center gap-1 text-xs text-muted"><TeamLogo team={p.team} size={12} />{p.team} · {p.pos}</div>
                      </div>
                      <div className="text-right text-xs tabular-nums">
                        <div><span className="font-medium text-fg">{Math.round(p.perceived)}</span> <span className="text-muted">they see</span></div>
                        <div className="text-muted">{p.ros} for you</div>
                      </div>
                    </div>
                    <p className="mt-1 pl-[38px] text-xs text-muted">{p.why}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">Nobody on your roster is worth much more to others than to you right now.</p>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
