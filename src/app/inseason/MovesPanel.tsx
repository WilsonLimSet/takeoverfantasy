'use client';

import type { MatchupGamesComparison, MatchupSideGames } from '@/types';
import Link from 'next/link';
import { Fragment } from 'react';
import type { MoveDay, PlayerOutlook, StreamingPlan, StreamMove, WatchlistNote } from '@/lib/inseason/streaming';
import type { GameRange } from '@/lib/inseason/gameLogs';
import type { PickTrackRecord } from '@/lib/inseason/pickLog';
import type { OpponentOutlook } from '@/lib/inseason/opponent';
import { Headshot, InjuryBadge, TeamLogo } from '@/components/ui';
import { Panel } from './useMe';

export interface MovesResponse {
  success: boolean;
  plan?: StreamingPlan | null;
  matchupGames?: MatchupGamesComparison;
  teamName?: string;
  espnUrl?: string;
  snapshotAge?: number;
  error?: string;
  needs?: 'signin' | 'pro' | 'connect' | 'refresh';
  /** Without a pass: what the moves would add this week, and the best one. */
  preview?: MovesPreview;
  record?: PickTrackRecord | null;
  overall?: PickTrackRecord | null;
  opponent?: OpponentOutlook | null;
}

export interface MovesPreview {
  week: number;
  daysLeft: number;
  pointsLeague: boolean;
  baseline: StreamingPlan['baseline'];
  after: StreamingPlan['after'];
  moveCount: number;
  firstMove: StreamMove | null;
  teamName?: string;
}

const dayLabel = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });

function Who({ id, name, team, meta, tone }: { id: number; name: string; team?: string; meta: string; tone: 'add' | 'drop' }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <Headshot id={id} name={name} size={36} />
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 truncate text-sm">
          <span className={`text-[10px] font-semibold uppercase tracking-wide ${tone === 'add' ? 'text-accent' : 'text-red-700'}`}>
            {tone === 'add' ? 'Add' : 'Drop'}
          </span>
          <span className="truncate font-medium">{name}</span>
        </div>
        <div className="flex items-center gap-1 text-xs text-muted">
          {team && <TeamLogo team={team} size={12} />}
          <span className="truncate">{meta}</span>
        </div>
      </div>
    </div>
  );
}

const fmt = (n: number) => n.toLocaleString('en-US');

/** "Usually 15–40 pts · under half his average 1 game in 5": the range behind the average. */
function rangeText(r: GameRange): string {
  const bust = r.bust >= 0.05 ? `under half his average about 1 game in ${Math.max(2, Math.round(1 / r.bust))}` : 'rarely under half his average';
  return `Usually ${r.low}–${r.high} pts a game · ${bust}`;
}

function CloseChip() {
  return <span className="ml-1.5 rounded bg-sunken px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-fg" title="The next option projects about the same. Either is a fine pick.">Close call</span>;
}

/**
 * A move's days: filled dot when his game makes your lineup, hollow when he plays but sits, blank
 * with no game. For the dropped player, the games you give up.
 */
function DayStrip({ days, tone }: { days: MoveDay[]; tone: 'add' | 'drop' }) {
  if (!days?.length) return null;
  return (
    <div className="mt-1.5 flex gap-1 pl-[46px]" aria-label={tone === 'add' ? 'Games that count' : 'Games you give up'}>
      {days.map((d) => (
        <div key={d.date} className="flex w-6 flex-col items-center gap-0.5" title={`${dayLabel(d.date)}: ${d.kept ? 'still plays for you before the swap' : d.counts ? (tone === 'add' ? 'starts' : 'you lose this game') : d.game ? 'plays, but your lineup is full' : 'no game'}`}>
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              d.kept ? 'bg-fg' : d.counts ? (tone === 'add' ? 'bg-accent' : 'bg-red-700') : d.game ? 'border border-muted' : 'bg-line/60'
            }`}
          />
          <span className="text-[9px] uppercase tracking-wide text-muted">{dayLabel(d.date).slice(0, 2)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * The answer first: what the moves add, which days they fill, and what that does to the matchup.
 * Then what's holding the moves back (the core list) and anything that blocks them.
 */
/** The moves' total, as the rows show it (each move's gain assumes the ones before it). */
const movesGain = (plan: Pick<StreamingPlan, 'moves'>) => Math.round(plan.moves.reduce((s, m) => s + m.pointsGain, 0));

/** When to make a move: now, or after a given day's games (US dates). */
const whenLabel = (m: StreamMove) => (m.swapAfter ? `After ${dayLabel(m.swapAfter.date)}’s games` : 'Now');

/**
 * The answer first: the moves to make, in order, each with when to make it and a backup if the
 * pickup is gone. Then what it does to the matchup, what the core list holds back, and blockers.
 */
export function EdgeCard({ plan, espnUrl, opp }: { plan: StreamingPlan; espnUrl?: string; opp?: OpponentOutlook | null }) {
  const gain = movesGain(plan);
  const m = plan.matchup;
  const unit = plan.pointsLeague ? 'pts' : 'games';
  const steps = [...plan.moves].sort((a, b) => (a.swapAfter?.date ?? '').localeCompare(b.swapAfter?.date ?? ''));
  const taken = new Set(plan.moves.map((x) => x.add.id));
  // Backups: the next-best free agents for the same drop, not already in the plan.
  const backups = (mv: StreamMove) =>
    (plan.freeAgents ?? []).filter((f) => f.dropFor === mv.drop.name && !taken.has(f.player.id) && f.pointsGain > 0).slice(0, 2);
  const spare = plan.addsLeft === null ? null : plan.addsLeft - plan.moves.length;
  // Their side if they use every pickup well: the margin that matters, and pickups we both want.
  const theirBest = opp?.projectedWithMoves !== undefined && opp.projected !== undefined && opp.projectedWithMoves > opp.projected ? opp.projectedWithMoves : undefined;
  const worst = m && theirBest !== undefined ? (plan.moves.length ? m.me.withMoves : m.me.projected) - theirBest : undefined;
  const contested = new Map((opp?.picks ?? []).map((p) => [p.addId, p]));
  return (
    <div className="animate-fade-up mb-5 rounded-xl border border-line bg-panel px-5 py-4 shadow-[0_1px_2px_rgba(25,25,25,0.04)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-lg font-medium tracking-tight">
            {plan.moves.length ? (
              <>
                Make {plan.moves.length === 1 ? 'this move' : `these ${plan.moves.length} moves`}:{' '}
                <span className="text-accent">+{fmt(gain)} {unit}</span> this week
              </>
            ) : (
              'No pickup beats your roster this week. Save your adds.'
            )}
          </p>
          {m && (() => {
            const mine = plan.moves.length ? m.me.withMoves : m.me.projected;
            const d = mine - m.opponent.projected;
            const word = (x: number) => (x >= 0 ? `win by about ${fmt(x)}` : `lose by about ${fmt(-x)}`);
            const safe = (worst ?? d) >= 150;
            return (
              <p className="mt-0.5 text-sm text-muted">
                {plan.moves.length ? `With ${plan.moves.length === 1 ? 'it' : 'them'} you` : 'You'}’re projected to{' '}
                <span className="font-medium text-fg">{word(d)}</span>
                {worst !== undefined && opp ? <>, or <span className={`font-medium ${worst >= 0 ? 'text-fg' : 'text-red-700'}`}>{word(worst)}</span> if {m.opponentName} use {opp.moves === 1 ? 'their pickup' : `all ${opp.moves} pickups`} well</> : null}.
                {safe && ' Only make moves you’d keep anyway.'}
              </p>
            );
          })()}
        </div>
        {espnUrl && plan.moves.length > 0 && (
          <a href={espnUrl} target="_blank" rel="noopener noreferrer" className="btn-accent shrink-0">Make moves on ESPN</a>
        )}
      </div>

      {steps.length > 0 && (
        <ol className="mt-3 divide-y divide-line rounded-lg border border-line">
          {steps.map((mv, i) => {
            const alt = backups(mv);
            return (
              <li key={mv.add.id} className="flex gap-3 px-3 py-2.5">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ink text-[11px] font-semibold text-white">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">{whenLabel(mv)}</span>
                    <span className="text-sm">
                      Add <span className="font-medium">{mv.add.name}</span>, drop <span className="font-medium">{mv.drop.name}</span>
                      {mv.add.onWaivers && <span className="text-muted"> (waiver claim, about 2 days)</span>}
                    </span>
                  </div>
                  {mv.hold && <p className="mt-0.5 text-xs text-muted">{mv.hold}</p>}
                  {contested.has(mv.add.id) && (
                    <p className="mt-0.5 text-xs font-medium text-red-700">
                      {m?.opponentName ?? 'Your opponent'} want him too (their #{(opp!.picks ?? []).findIndex((p) => p.addId === mv.add.id) + 1} pickup){mv.swapAfter ? ': if you wait, he may be gone' : ': adding him takes him from them'}.
                    </p>
                  )}
                  {alt.length > 0 && (
                    <p className="mt-0.5 text-xs text-muted">
                      If he’s taken: {alt.map((f, j) => (
                        <span key={f.player.id}>{j > 0 && ', then '}<span className="text-fg">{f.player.name}</span> (+{Math.round(f.pointsGain)})</span>
                      ))}
                    </p>
                  )}
                  <details className="group mt-1">
                    <summary className="cursor-pointer list-none text-xs text-muted underline-offset-2 hover:text-fg hover:underline">
                      <span className="group-open:hidden">Why this move</span><span className="hidden group-open:inline">Hide</span>
                    </summary>
                    <div className="mt-2"><MoveRow m={mv} mode={plan.mode?.kind} /></div>
                  </details>
                </div>
                <span className="shrink-0 text-sm font-medium tabular-nums">+{Math.round(mv.pointsGain)}</span>
              </li>
            );
          })}
        </ol>
      )}

      {plan.coreCost && (
        <p className="mt-3 text-sm">
          <span className="font-medium">
            {spare && spare > 0 ? `${spare} more ${spare === 1 ? 'pickup' : 'pickups'} unused: ` : 'More if you’ll drop a core player: '}
          </span>
          <span className="text-muted">
            {spare && spare > 0 ? 'everyone else is on your core list. Dropping a core player would add ' : ''}
            {plan.coreCost.players.map((p, i) => (
              <span key={p.id}>
                {i > 0 && (i === plan.coreCost!.players.length - 1 ? ' or ' : ', ')}
                {p.name} for {p.addName} (+{p.pointsGain})
              </span>
            ))}
            .{' '}
          </span>
          <Link href="/inseason/connect" className="underline hover:text-fg">Edit core players</Link>
        </p>
      )}
      {(plan.warnings?.length ?? 0) > 0 && (
        <ul className="mt-2 space-y-1">
          {plan.warnings.map((w) => (
            <li key={w} className="text-sm font-medium text-red-700">⚠ {w}</li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted">
        Streaming spots: {plan.droppable.map((p) => p.name).join(', ') || 'none'}.{' '}
        <Link href="/inseason/connect" className="underline hover:text-fg">{plan.coreIsDefault ? 'Pick your core players' : 'Edit core players'}</Link>
      </p>
    </div>
  );
}

export function MoveRow({ m, mode }: { m: StreamMove; mode?: StreamingPlan['mode']['kind'] }) {
  return (
    <div className="border-t border-line py-3 first:border-t-0 first:pt-0 last:pb-0">
      <div className="grid grid-cols-[1fr_auto] items-center gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <div className="col-start-1 row-start-1 min-w-0">
        <Who
          id={m.add.id}
          name={m.add.name}
          team={m.add.nbaTeamAbbrev}
          tone="add"
          meta={`${m.add.nbaTeamAbbrev ?? ''} · ${m.add.gamesLeft} games left${m.add.gamesNext !== undefined ? ` · ${m.add.gamesNext} next wk` : ''} · ${m.add.fppg} pts/g${m.add.onWaivers ? ' · waivers' : ''}`}
        />
        <DayStrip days={m.addDays} tone="add" />
        </div>
        <div className="col-span-2 col-start-1 row-start-2 min-w-0 sm:col-span-1 sm:col-start-2 sm:row-start-1">
          <Who
            id={m.drop.id}
            name={m.drop.name}
            team={m.drop.nbaTeamAbbrev}
            tone="drop"
            meta={`${m.drop.nbaTeamAbbrev ?? ''} · ${m.drop.gamesLeft} games left${m.drop.gamesNext !== undefined ? ` · ${m.drop.gamesNext} next wk` : ''} · ${m.drop.fppg} pts/g`}
          />
          <DayStrip days={m.dropDays} tone="drop" />
        </div>
        <div className="col-start-2 row-start-1 text-right sm:col-start-3">
          <div className="text-lg font-medium tabular-nums tracking-tight">+{Math.round(m.pointsGain)}</div>
          <div className="text-[11px] uppercase tracking-wide text-muted">proj pts</div>
          {m.swapAfter && (
            <div className="mt-1 whitespace-nowrap rounded bg-sunken px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-fg">
              After {m.swapAfter.label.split(',')[0]}
            </div>
          )}
        </div>
      </div>
      <p className="mt-2 text-xs text-muted">
        <span className="mr-1.5 rounded bg-sunken px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-fg">
          {m.kind === 'upgrade' ? 'Upgrade' : m.kind === 'opportunity' ? 'While out' : 'Stream'}
        </span>
        {m.reason}
      </p>
      {m.hold && <p className="mt-1 text-xs font-medium text-fg">{m.hold}</p>}
      {m.altDrop && (
        <p className="mt-1 text-xs text-muted">
          Why {m.drop.name}: he costs you the least. Dropping {m.altDrop.name} instead adds +{Math.round(m.altDrop.pointsGain)}{m.altDrop.pointsGain >= m.pointsGain - 0.5 ? ', about the same' : ''}.
        </p>
      )}
      {m.add.range && <p className="mt-1 text-xs text-muted">{m.add.name}: {rangeText(m.add.range).replace(/^U/, 'u')}.</p>}
      {m.runnerUp && m.runnerUp.pointsGain > m.pointsGain + 0.5 ? (
        <p className="mt-1 text-xs text-muted">
          {m.close && <CloseChip />} Ranked over {m.runnerUp.name} (+{Math.round(m.runnerUp.pointsGain)} projected): {mode === 'chase' ? 'more upside when you need to catch up' : 'a safer floor while you’re ahead'}.
        </p>
      ) : m.close && m.runnerUp ? (
        <p className="mt-1 text-xs text-muted">
          <CloseChip /> {m.runnerUp.name} adds about the same (+{Math.round(m.runnerUp.pointsGain)}). Either is a fine pick.
        </p>
      ) : null}
      {m.nextWeekWarning && <p className="mt-1 text-xs font-medium text-red-700">{m.nextWeekWarning}</p>}
      {m.keepWarning && <p className="mt-1 text-xs font-medium text-red-700">{m.keepWarning}</p>}
    </div>
  );
}

export function StatStrip({ plan, mg }: { plan: StreamingPlan; mg?: MatchupGamesComparison }) {
  const gain = movesGain(plan);
  const items = [
    {
      k: mg?.opponent ? `Usable games vs ${mg.opponent.name}` : 'Usable games left',
      v: mg?.opponent ? `${mg.me.usableGames}–${mg.opponent.usableGames}` : String(plan.baseline.usableGames),
    },
    { k: plan.pointsLeague ? 'Points from moves' : 'Games from moves', v: gain > 0 ? `+${gain}` : '0' },
    { k: 'Pickups left', v: plan.addsLeft === null ? 'No limit' : String(plan.addsLeft) },
  ];
  return (
    <dl className="animate-fade-up grid grid-cols-3 divide-x divide-line rounded-xl border border-line bg-panel text-center shadow-[0_1px_2px_rgba(25,25,25,0.04)]">
      {items.map((x) => (
        <div key={x.k} className="px-2 py-4 sm:px-6">
          <dd className="text-2xl font-medium tracking-tight tabular-nums">{x.v}</dd>
          <dt className="mt-0.5 text-[11px] uppercase leading-tight tracking-wide text-muted">{x.k}</dt>
        </div>
      ))}
    </dl>
  );
}

/** Empty starting spots on each day left with NBA games (none before today or on days off). */
const openByDay = (side: MatchupSideGames, data: Pick<MatchupGamesComparison, 'days' | 'today' | 'startingSlots' | 'teamsPlaying'>) =>
  data.days.map((d, i) => (d.scoringPeriodId < data.today || data.teamsPlaying?.[i] === 0 ? null : data.startingSlots - side.startableByDay[i]));

/** "20 open lineup spots left: Thu 8, Fri 2, Sat 4, Sun 6", and which days are already full. */
function SideTable({ side, data }: { side: MatchupSideGames; data: MatchupGamesComparison }) {
  const { days, today, startingSlots } = data;
  const open = openByDay(side, data);
  // Red: misses 3+ of the game nights left.
  const gameNights = days.filter((_, i) => (data.teamsPlaying?.[i] ?? 1) > 0).length;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
            <th className="pb-2 font-medium">{side.name}</th>
            <th className="pb-2 text-right font-medium" title="Games left">Left</th>
            {days.map((d) => (
              <th key={d.scoringPeriodId} className={`w-8 pb-2 text-center font-medium ${d.scoringPeriodId < today ? 'opacity-40' : ''}`}>
                {dayLabel(d.date).slice(0, 2)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {side.players.map((p) => (
            <tr key={p.playerId} className={`border-t border-line ${p.injured ? 'opacity-40' : ''}`}>
              <td className="py-1.5 pr-2">
                <div className="flex max-w-[12rem] items-center gap-1.5">
                  <Headshot id={p.playerId} name={p.name} size={22} />
                  <span className="truncate">{p.name}</span>
                  {p.nbaTeamAbbrev && <TeamLogo team={p.nbaTeamAbbrev} size={12} />}
                  <InjuryBadge s={p.status} />
                </div>
              </td>
              <td className={`py-1.5 text-right tabular-nums font-medium ${p.games >= 4 ? 'text-accent' : gameNights - p.games >= 3 ? 'text-red-700' : ''}`}>{p.games}</td>
              {p.playsByDay.map((plays, i) => (
                <td key={i} className="py-1.5 text-center">
                  {plays ? <span className="inline-block h-1.5 w-1.5 rounded-full bg-fg" /> : <span className="text-line">·</span>}
                </td>
              ))}
            </tr>
          ))}
          <tr className="border-t border-line text-xs text-muted">
            <td className="py-1.5">Healthy playing</td>
            <td className="py-1.5 text-right tabular-nums font-medium text-fg">{side.totalGames}</td>
            {side.playingByDay.map((n, i) => (
              <td key={i} className="py-1.5 text-center tabular-nums">{n}</td>
            ))}
          </tr>
          <tr className="text-xs text-muted">
            <td className="py-1.5">Can start</td>
            <td className="py-1.5 text-right tabular-nums font-medium text-fg">{side.usableGames}</td>
            {side.startableByDay.map((n, i) => (
              // Darker where positions (not just the 10-spot cap) leave someone on the bench.
              <td key={i} className={`py-1.5 text-center tabular-nums ${n < Math.min(side.playingByDay[i], startingSlots) ? 'font-medium text-fg' : ''}`}>{n}</td>
            ))}
          </tr>
          <tr className="text-xs text-muted">
            <td className="py-1.5">Open spots</td>
            <td className="py-1.5 text-right tabular-nums font-medium text-fg">{open.reduce<number>((sum, n) => sum + (n ?? 0), 0)}</td>
            {open.map((n, i) => (
              // Empty starting spots left this week: where a pickup adds games.
              <td key={i} className={`py-1.5 text-center tabular-nums ${n ? 'font-medium text-accent' : ''}`}>{n ?? ''}</td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function MatchupGamesPanel({ data }: { data: MatchupGamesComparison }) {
  const { me, opponent, days, startingSlots } = data;
  const range = days.length ? `${dayLabel(days[0].date)} ${days[0].date.slice(5)} – ${dayLabel(days[days.length - 1].date)} ${days[days.length - 1].date.slice(5)}` : '';
  return (
    <Panel
      title="Games left this week"
      sub={`Who can start each day in your ${startingSlots} spots. Green open spots are where a pickup adds games.`}
      right={range}
    >
      {!days.length ? <p className="text-sm text-muted">No games left this week.</p> : <div className={`grid gap-6 ${opponent ? 'lg:grid-cols-2' : ''}`}>
        <SideTable side={me} data={data} />
        {opponent && <SideTable side={opponent} data={data} />}
      </div>}
    </Panel>
  );
}

export function WatchlistPanel({ notes }: { notes: WatchlistNote[] }) {
  const list = notes.filter((w) => !w.rostered).slice(0, 12);
  if (!list.length) return null;
  return (
    <Panel title="Watchlist" sub="Synced from your ESPN watchlist">
      <ul className="-my-1">
        {list.map((w) => (
          <li key={w.player.id} className="flex items-center gap-2.5 border-t border-line py-2 first:border-t-0">
            <Headshot id={w.player.id} name={w.player.name} size={28} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{w.player.name}<InjuryBadge s={w.player.status} /></div>
              <div className="truncate text-xs text-muted">
                {w.player.nbaTeamAbbrev} · {w.player.gamesLeft} left{w.player.gamesNext !== undefined ? ` · ${w.player.gamesNext} next wk` : ''} · {w.player.fppg} pts/g{w.player.onWaivers ? ' · waivers' : ''}{w.player.opportunity ? ` · ${w.player.opportunity}` : ''}
              </div>
            </div>
            <div className="text-right text-xs">
              {w.bestMove ? (
                <>
                  <div className="font-medium tabular-nums text-fg">+{Math.round(w.bestMove.pointsGain)}</div>
                  <div className="text-muted">for {w.bestMove.drop.name}</div>
                </>
              ) : (
                <span className="text-muted">Hold</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

const dayList = (dates: string[]) => {
  const names = dates.map((d) => dayLabel(d));
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
};

/**
 * The turn of the week: free agents who play the week's last days and early next week, so one
 * pickup covers both. Shown only in the last couple of days of a matchup.
 */
export function BridgePanel({ bridge, addsLeft, espnUrl, mode }: { bridge: NonNullable<StreamingPlan['bridge']>; addsLeft: number | null; espnUrl?: string; mode?: StreamingPlan['mode'] }) {
  if (!bridge.picks.length) return null;
  const now = bridge.days.filter((d) => !d.next).map((d) => d.date);
  const early = bridge.days.filter((d) => d.next).map((d) => d.date);
  const split = now.length;
  return (
    <Panel
      title={`Plays ${dayList(now)} and early next week`}
      sub={`Your week ends ${dayLabel(now[now.length - 1])}. Each of these plays then and on ${dayList(early)}, so one pickup counts for both weeks.${addsLeft !== null ? ' Your pickup limit resets next week.' : ''} Free agents only: add now.${mode?.note ? ` ${mode.note}` : ''}`}
      right={espnUrl ? <a href={espnUrl} target="_blank" rel="noopener noreferrer" className="btn-accent">Add on ESPN</a> : undefined}
      className="mb-5"
    >
      <ul className="-my-1">
        {bridge.picks.map((p) => (
          <li key={p.player.id} className="flex items-center gap-3 border-t border-line py-2.5 first:border-t-0">
            <Headshot id={p.player.id} name={p.player.name} size={36} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 truncate text-sm">
                <span className="truncate font-medium">{p.player.name}</span>
                <InjuryBadge s={p.player.status} />
                {p.close && <CloseChip />}
              </div>
              <div className="flex items-center gap-1 text-xs text-muted">
                {p.player.nbaTeamAbbrev && <TeamLogo team={p.player.nbaTeamAbbrev} size={12} />}
                <span className="truncate">
                  {p.player.fppg} pts/game{p.player.gamesNext !== undefined ? ` · ${p.player.gamesNext} games next week` : ''} · drop {p.drop}
                </span>
              </div>
              {p.player.range && <div className="truncate text-xs text-muted">{rangeText(p.player.range)}</div>}
            </div>
            <div className="hidden shrink-0 gap-1 sm:flex" aria-label="Games by day">
              {p.days.map((d, i) => (
                <Fragment key={bridge.days[i].date}>
                  {i === split && <span aria-hidden className="mx-1 w-px self-stretch bg-line" />}
                  <div className="flex w-6 flex-col items-center gap-0.5" title={`${dayLabel(bridge.days[i].date)}${i >= split ? ' (next week)' : ''}: ${d.counts ? 'starts' : d.game ? 'plays, but your lineup is full' : 'no game'}`}>
                    <span className={`inline-block h-2 w-2 rounded-full ${d.counts ? 'bg-accent' : d.game ? 'border border-muted' : 'bg-line/60'}`} />
                    <span className="text-[9px] uppercase tracking-wide text-muted">{dayLabel(bridge.days[i].date).slice(0, 2)}</span>
                  </div>
                </Fragment>
              ))}
            </div>
            <div className="w-14 shrink-0 text-right">
              <div className="text-sm font-medium tabular-nums text-accent">+{p.pointsGain}</div>
              <div className="text-[10px] uppercase tracking-wide text-muted">pts</div>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-3 border-t border-line pt-2.5 text-xs text-muted">
        Points he adds in your lineup over {dayList(now)} and {dayList(early).replace(' or ', ' and ')}. Dots: filled when his game makes your lineup. One game is a coin flip: the range is what a normal night looks like. After {dayLabel(early[early.length - 1])} you can swap him for next week&apos;s best pickup.
      </p>
    </Panel>
  );
}

/** How our past picks did: our #1 against the option we ranked next, graded after the games. */
export function TrackRecordPanel({ record, overall }: { record?: PickTrackRecord | null; overall?: PickTrackRecord | null }) {
  const pct = (r: PickTrackRecord) => Math.round((100 * r.beatNext) / r.graded);
  return (
    <Panel title="Our track record" sub="Every day we log our top pickup and the next option, then grade both after the games.">
      {record && record.graded > 0 ? (
        <>
          <p className="text-sm">
            Our #1 outscored our #2 in <span className="font-medium tabular-nums">{record.beatNext} of {record.graded}</span> picks for your team ({pct(record)}%).
          </p>
          <p className="mt-1 text-xs text-muted">
            Our #1s scored {fmt(record.scored)} pts against {fmt(record.expected)} projected
            {record.avgPlace !== undefined ? `, finishing #${record.avgPlace} on average among the options we listed` : ''}.
          </p>
          <ul className="mt-2 space-y-1 text-xs">
            {record.recent.map((x) => (
              <li key={`${x.date}${x.pick}`} className="flex justify-between gap-2">
                <span className="truncate text-muted">{dayLabel(x.date)} · {x.pick} <span className="text-fg tabular-nums">{x.got}</span> vs {x.next} <span className="text-fg tabular-nums">{x.nextGot}</span></span>
                <span className={x.got >= x.nextGot ? 'text-accent' : 'text-red-700'}>{x.got >= x.nextGot ? 'Right' : 'Wrong'}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-sm text-muted">No graded picks yet. The first grades show up the day after their games.</p>
      )}
      {overall && overall.graded >= 10 && (
        <p className="mt-3 border-t border-line pt-2.5 text-xs text-muted">
          All leagues: our #1 beat our #2 in {overall.beatNext} of {overall.graded} ({pct(overall)}%).
        </p>
      )}
    </Panel>
  );
}

/**
 * You vs them, side by side: games left, pickups left, and what each side's best moves add (our
 * move engine run for both rosters). A games edge can vanish if they have more pickups left.
 */
export function HeadToHead({ plan, mg, o }: { plan: StreamingPlan; mg?: MatchupGamesComparison; o: OpponentOutlook }) {
  const adds = (n: number | null) => (n === null ? '∞' : String(n));
  const p = plan.matchup;
  const stats = [
    ...(p ? [{ k: 'Score now', me: p.me.now, them: p.opponent.now }, { k: 'Projected', me: p.me.projected, them: p.opponent.projected }] : []),
    { k: 'Games that count', me: plan.baseline.usableGames, them: o.games },
    { k: 'Pickups left', me: adds(plan.addsLeft), them: adds(o.addsLeft) },
  ];
  const weekDays = mg?.days ?? [];
  // Points a game over his starts (a teammate's return can change it mid-week).
  const per = (x: PlayerOutlook) => Math.round(x.starts ? x.points / x.starts : x.fppg);
  const mine = plan.outlook ?? [];
  const theirs = o.outlook ?? [];
  const wd = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  return (
    <Panel
      title={`You vs ${o.name}`}
      className="mb-5"
    >
      {p && (
        <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3 text-center">
          <div>
            <div className="truncate text-xs text-muted">You</div>
            <div className={`text-3xl font-medium tabular-nums tracking-tight ${p.me.now >= p.opponent.now ? '' : 'text-muted'}`}>{p.me.now}</div>
          </div>
          <div className="pb-1.5 text-[11px] uppercase tracking-wide text-muted">Now</div>
          <div>
            <div className="truncate text-xs text-muted">{o.name}</div>
            <div className={`text-3xl font-medium tabular-nums tracking-tight ${p.opponent.now > p.me.now ? '' : 'text-muted'}`}>{p.opponent.now}</div>
          </div>
        </div>
      )}
      <table className="mt-3 w-full text-sm">
        <tbody>
          {stats.filter((x) => x.k !== 'Score now').map((x) => {
            const a = Number(x.me), b = Number(x.them);
            const lead = Number.isFinite(a) && Number.isFinite(b) && a !== b ? (a > b ? 'me' : 'them') : null;
            return (
              <tr key={x.k} className="border-t border-line">
                <td className={`w-1/3 py-1.5 text-left tabular-nums ${lead === 'me' ? 'font-semibold text-accent' : ''}`}>{x.me}</td>
                <td className="py-1.5 text-center text-xs text-muted">{x.k}</td>
                <td className={`w-1/3 py-1.5 text-right tabular-nums ${lead === 'them' ? 'font-semibold text-red-700' : ''}`}>{x.them}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {(mine.length > 0 || theirs.length > 0) && (
        <div className="mt-4 border-t border-line pt-3">
          <div className="grid gap-5 lg:grid-cols-2">
            {[{ k: 'You', list: mine }, { k: o.name, list: theirs }].map((side) => (
              <table key={side.k} className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
                    <th className="pb-1.5 font-medium">{side.k}</th>
                    {weekDays.map((d) => <th key={d.date} className="w-7 pb-1.5 text-center font-medium">{wd(d.date).slice(0, 2)}</th>)}
                    <th className="pb-1.5 pl-2 text-right font-medium">Pts</th>
                  </tr>
                </thead>
                <tbody>
                  {side.list.map((x) => (
                    <tr key={x.id} className="border-t border-line">
                      <td className="py-1.5 pr-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <Headshot id={x.id} name={x.name} size={28} />
                          <div className="min-w-0">
                            <div className="truncate font-medium">
                              {x.name}
                              {x.back ? (
                                <span className="ml-1 text-[11px] font-semibold text-muted" title="Tagged out, but the injury report has him back then">Back {new Date(`${x.back}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })}</span>
                              ) : x.status !== 'ACTIVE' && <span className="ml-1 text-[11px] font-semibold text-red-700">{x.status === 'DAY_TO_DAY' ? 'DTD' : x.status}</span>}
                            </div>
                            <div className="flex items-center gap-1 text-xs text-muted">
                              {x.nbaTeamAbbrev && <TeamLogo team={x.nbaTeamAbbrev} size={12} />}
                              {x.nbaTeamAbbrev} · {x.starts} × {per(x)}
                            </div>
                          </div>
                        </div>
                      </td>
                      {weekDays.map((d, i) => (
                        <td key={d.date} className="text-center">
                          {x.days[i] === 'start' ? (
                            <span className={`inline-block h-2 w-2 rounded-full ${x.doubtful ? 'border border-red-700' : 'bg-fg'}`} />
                          ) : x.days[i] === 'bench' ? (
                            <span className="inline-block h-2 w-2 rounded-full border border-muted" />
                          ) : (
                            <span className="text-line">·</span>
                          )}
                        </td>
                      ))}
                      <td className="py-1.5 pl-2 text-right tabular-nums">
                        {x.points ? <span className="font-medium">{x.points}</span> : <span className="text-muted">0</span>}
                        {x.doubtful > 0 && <div className="text-[11px] text-red-700">or {Math.max(0, x.points - per(x) * x.doubtful)} if he sits</div>}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t border-line text-xs text-muted">
                    <td className="py-1.5">Starters each night</td>
                    {weekDays.map((d, i) => (
                      <td key={d.date} className="py-1.5 text-center tabular-nums">{side.list.filter((x) => x.days[i] === 'start').length}</td>
                    ))}
                    <td />
                  </tr>
                  <tr className="border-t border-line text-muted">
                    <td className="py-1.5" colSpan={weekDays.length + 1}>Total{side.list.some((x) => x.doubtful) ? ' if everyone plays' : ''}</td>
                    <td className="py-1.5 pl-2 text-right font-medium tabular-nums text-fg">{side.list.reduce((t, x) => t + x.points, 0)}</td>
                  </tr>
                </tbody>
              </table>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">
            Filled dot: he starts that night. Hollow: he plays but the lineup is full. Red: he’s day-to-day, so those games score full or 0. “Back Sat”: listed out, counted from the day the injury report has him back. Points = starts × his points a game now (recent minutes × points per minute).
          </p>
        </div>
      )}
      {(o.picks?.length ?? 0) > 0 && (
        <details className="mt-4 border-t border-line pt-3">
          <summary className="cursor-pointer text-sm font-medium">
            What {o.name} could add: +{o.pointsGain} with {o.moves} {o.moves === 1 ? 'pickup' : 'pickups'}
          </summary>
          <ol className="space-y-1 text-sm">
            {o.picks!.map((x, i) => (
              <li key={x.addId} className="flex justify-between gap-3">
                <span>
                  <span className="text-muted">{i + 1}. </span>
                  Add <span className="font-medium">{x.add}</span>{x.addTeam ? <span className="text-muted"> ({x.addTeam})</span> : null}, drop {x.drop}
                  {x.after && <span className="text-muted"> after {x.after}</span>}
                </span>
                <span className="shrink-0 tabular-nums text-muted">+{x.gain}</span>
              </li>
            ))}
          </ol>
          <p className="mt-2 text-xs text-muted">Their ceiling: the best moves our engine finds for them. Most managers won’t drop players this good.</p>
        </details>
      )}
    </Panel>
  );
}
