'use client';

import Link from 'next/link';
import { track } from '@vercel/analytics';
import { funnel } from '@/components/funnel';
import { useCallback, useEffect, useState } from 'react';
import type { DailyBriefing } from '@/types';
import { InjuryBadge } from '@/components/ui';
import { BridgePanel, EdgeCard, TrackRecordPanel, MatchupGamesPanel, MoveRow, StatStrip, WatchlistPanel, type MovesPreview, type MovesResponse } from './MovesPanel';
import { ErrorBox, formatAge, Gate, invalidateCached, Loading, MOVES_URL, Panel, SaveLeague, useCached, useMeContext } from './useMe';

function RosterAlerts({ briefing }: { briefing: DailyBriefing }) {
  const changes = briefing.statusChanges.filter((c) => c.isMyPlayer);
  const hurt = (briefing.myTeam.roster ?? []).filter((r) => r.player.status !== 'ACTIVE');
  return (
    <Panel title="Roster alerts">
      {changes.length === 0 && hurt.length === 0 ? (
        <p className="text-sm text-muted">Everyone on your roster is healthy.</p>
      ) : (
        <ul className="-my-1 text-sm">
          {changes.map((c) => (
            <li key={`c${c.playerId}`} className="border-t border-line py-2 first:border-t-0">
              <span className="font-medium">{c.playerName}</span>
              <span className="text-muted"> {c.previousStatus.replace(/_/g, ' ').toLowerCase()} → </span>
              <InjuryBadge s={c.currentStatus} />
              {c.currentStatus === 'ACTIVE' && <span className="text-accent">active</span>}
            </li>
          ))}
          {hurt
            .filter((r) => !changes.some((c) => c.playerId === r.playerId))
            .map((r) => (
              <li key={`h${r.playerId}`} className="border-t border-line py-2 first:border-t-0">
                {r.player.name}
                <InjuryBadge s={r.player.status} />
                {r.lineupSlotId === 13 && <span className="ml-1.5 text-xs text-muted">on IR</span>}
              </li>
            ))}
        </ul>
      )}
    </Panel>
  );
}

/** A connected league without a pass: show what they're missing, give the best move away, then the plans. */
function Preview({ p }: { p: MovesPreview }) {
  const games = p.after.usableGames - p.baseline.usableGames;
  const points = Math.round(p.after.points - p.baseline.points);
  const gain = p.pointsLeague ? `${points} points` : `${games} ${games === 1 ? 'game' : 'games'}`;
  const hidden = p.moveCount - 1;
  useEffect(() => { track('preview_seen', { moves: p.moveCount }); funnel('preview_seen'); }, [p.moveCount]);
  return (
    <div className="mb-5 space-y-5">
      <div>
        <h1 className="text-3xl font-medium leading-tight tracking-[-0.03em]">
          {p.moveCount ? `You’re leaving ${gain} on the table` : 'Your roster is set this week'}
        </h1>
        <p className="mt-2 text-sm text-muted">
          {p.teamName ? `${p.teamName} · ` : ''}Week {p.week} · {p.daysLeft} {p.daysLeft === 1 ? 'day' : 'days'} left ·{' '}
          {p.moveCount
            ? `${p.baseline.usableGames} usable games now, ${p.after.usableGames} with ${p.moveCount} ${p.moveCount === 1 ? 'move' : 'moves'}.`
            : `${p.baseline.usableGames} usable games. We’ll tell you when a move is worth it.`}
        </p>
      </div>
      {p.firstMove && (
        <Panel title="Your best move, free" sub="Make it on ESPN today.">
          <MoveRow m={p.firstMove} />
          {hidden > 0 && (
            <div className="mt-3 border-t border-line pt-3">
              <div aria-hidden className="select-none space-y-2 blur-[5px]">
                {Array.from({ length: Math.min(hidden, 3) }, (_, i) => (
                  <div key={i} className="flex justify-between text-sm"><span>Add Player Name · Drop Player Name</span><span>+00</span></div>
                ))}
              </div>
              <p className="mt-2 text-sm font-medium">{hidden} more {hidden === 1 ? 'move' : 'moves'} this week with a pass.</p>
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}

export default function ThisWeekPage() {
  const { me } = useMeContext();
  const { data: moves, reload: reloadMoves } = useCached<MovesResponse>(MOVES_URL);
  const { data: briefingRes, reload: reloadBriefing } = useCached<{ success: boolean; briefing?: DailyBriefing }>('/api/inseason/briefing');
  const briefing = briefingRes?.success ? briefingRes.briefing ?? null : null;
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => { await Promise.all([reloadMoves(), reloadBriefing()]); }, [reloadMoves, reloadBriefing]);

  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const j = await fetch('/api/inseason/refresh', { method: 'POST' }).then((r) => r.json());
      if (!j.success) setError(j.error ?? 'Refresh failed');
      await load();
      invalidateCached('/api/inseason/weekly-plan');
    } finally {
      setRefreshing(false);
    }
  };

  if (!moves) return <Loading what="your week" kind="week" />;
  const needs = moves.needs;
  // A guest's next steps after the preview: save the league with an email, or buy the rest of the moves.
  if (needs === 'pro' && moves.preview) {
    return <><Preview p={moves.preview} />{me && !me.signedIn && <div className="mb-5"><SaveLeague /></div>}<Gate needs="pro" /></>;
  }
  if (needs === 'signin' || needs === 'pro' || needs === 'connect') return <Gate needs={needs} />;

  const refreshButton = (
    <button onClick={refresh} disabled={refreshing} className="btn-ghost">
      {refreshing ? 'Refreshing…' : 'Refresh'}
    </button>
  );

  if (!moves.success || !moves.plan) {
    return (
      <div>
        {error && <ErrorBox>{error}</ErrorBox>}
        <Panel title="No league data yet">
          <p className="mb-3 text-sm text-muted">{moves.error ?? 'We couldn’t build this week’s plan yet.'}</p>
          {refreshButton}
        </Panel>
      </div>
    );
  }

  const { plan, matchupGames: mg } = moves;
  return (
    <div>
      {error && <ErrorBox>{error}</ErrorBox>}
      <div className="mb-5 grid gap-6 lg:grid-cols-[1fr_auto] lg:items-end">
        <div>
          <h1 className="text-3xl font-medium leading-tight tracking-[-0.03em]">
            Week {plan.week}
            <span className="text-muted"> · {plan.daysLeft} {plan.daysLeft === 1 ? 'day' : 'days'} left</span>
          </h1>
          <p className="mt-2 flex flex-wrap items-center gap-3 text-sm text-muted">
            <span>{moves.teamName ?? me?.profile?.teamName}{mg?.opponent ? ` vs ${mg.opponent.name}` : ''}</span>
            <span>Updated {formatAge(moves.snapshotAge ?? 0)}</span>
            {refreshButton}
          </p>
        </div>
        <StatStrip plan={plan} mg={mg} />
      </div>
      <EdgeCard plan={plan} espnUrl={moves.espnUrl} />
      {plan.bridge && <BridgePanel bridge={plan.bridge} addsLeft={plan.addsLeft} espnUrl={moves.espnUrl} mode={plan.mode} />}

      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="space-y-5">
          <Panel
            title="Why these moves"
            sub={plan.moves.length ? `Each move assumes the ones above it are made. Dots: days his game makes your lineup.${plan.mode?.note && plan.mode.kind !== 'even' ? ` ${plan.mode.note}` : ''}` : undefined}
          >
            {plan.moves.length ? (
              plan.moves.map((m) => <MoveRow key={m.add.id} m={m} mode={plan.mode?.kind} />)
            ) : (
              <p className="text-sm text-muted">No add/drop beats your current roster this week. Sit tight.</p>
            )}
            <p className="mt-4 border-t border-line pt-3 text-xs text-muted">
              Streaming spots: {plan.droppable.map((p) => (p.gamesNext !== undefined ? `${p.name} (${p.gamesNext} next wk)` : p.name)).join(', ') || 'none'}.{' '}
              <Link href="/inseason/connect" className="underline hover:text-fg">
                {plan.coreIsDefault ? 'Pick your core players' : 'Edit core players'}
              </Link>
            </p>
          </Panel>
          {me?.profile && !me.profile.telegram && me.telegramBot && (
            <Link href="/inseason/connect#alerts" className="flex items-center justify-between gap-3 rounded-xl border border-line bg-panel px-4 py-3 text-sm shadow-[0_1px_2px_rgba(25,25,25,0.04)] hover:border-fg/30">
              <span><span className="font-medium">Get these moves on Telegram each morning.</span> <span className="text-muted">Takes 10 seconds.</span></span>
              <span className="btn-ghost shrink-0">Set up</span>
            </Link>
          )}
          {me && !me.signedIn && me.guest && <SaveLeague />}
          {mg && <MatchupGamesPanel data={mg} />}
        </div>
        <div className="space-y-5">
          {briefing && <RosterAlerts briefing={briefing} />}
          {plan.pointsLeague && <TrackRecordPanel record={moves.record} overall={moves.overall} />}
          <WatchlistPanel notes={plan.watchlist} />
        </div>
      </div>
    </div>
  );
}
