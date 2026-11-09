'use client';

import type { MatchupGamesComparison } from '@/types';
import type { StreamingPlan } from '@/lib/inseason/streaming';
import { Headshot, InjuryBadge, TeamLogo } from '@/components/ui';
import { Panel } from './useMe';

const dayLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
const list = (names: string[]) => (names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

type Verdict = { text: string; tone: 'act' | 'keep' | 'muted'; order: number };

/**
 * Who to keep and when a spot opens, player by player. A streaming spot whose team is done early
 * (plays Mon and Tue, then nothing) is a free pickup after his last game: drop him that night for
 * someone who plays the days left. Players who play 4 games are the ones to hold.
 */
export function SchedulePanel({ data, plan }: { data: MatchupGamesComparison; plan: StreamingPlan }) {
  const { days, today, startingSlots, me } = data;
  const left = days.map((d, i) => (d.scoringPeriodId >= today ? i : -1)).filter((i) => i >= 0);
  if (!left.length) return null;
  const open = days.map((_, i) => startingSlots - me.startableByDay[i]);
  const streamIds = new Set(plan.droppable.map((p) => p.id));
  const nextBy = new Map((data.teams ?? []).map((t) => [t.abbrev, t.next]));
  const lastDay = left[left.length - 1];

  const rows = me.players.map((p) => {
    const plays = left.filter((i) => p.playsByDay[i]);
    const stream = streamIds.has(p.playerId);
    const last = plays[plays.length - 1];
    const after = left.filter((i) => i > (last ?? -1) && open[i] > 0 && (data.teamsPlaying?.[i] ?? 1) > 0);
    let v: Verdict;
    if (p.injured) v = { text: 'Out', tone: 'muted', order: 9 };
    else if (stream && !plays.length) v = { text: after.length ? `No games left: his spot is free now (${list(after.map((i) => dayLabel(days[i].date)))})` : 'No games left', tone: after.length ? 'act' : 'muted', order: 0 };
    else if (stream && last < lastDay && after.length) v = { text: `Done after ${dayLabel(days[last].date)}: stream his spot ${list(after.map((i) => dayLabel(days[i].date)))}`, tone: 'act', order: 1 };
    else if (plays.length >= 4) v = { text: `Keep: ${plays.length} games left`, tone: 'keep', order: 3 };
    else if (stream) v = { text: plays.length >= 3 ? 'Keep this week' : `Streaming spot · ${plays.length} left`, tone: plays.length >= 3 ? 'keep' : 'muted', order: plays.length >= 3 ? 4 : 2 };
    else v = { text: `${plays.length} ${plays.length === 1 ? 'game' : 'games'} left`, tone: 'muted', order: 5 };
    return { p, plays, v, next: p.nbaTeamAbbrev ? nextBy.get(p.nbaTeamAbbrev) : undefined };
  }).sort((a, b) => a.v.order - b.v.order || b.plays.length - a.plays.length);

  // Light nights are where streamers start for you: fewer of your players play.
  const nights = left.filter((i) => (data.teamsPlaying?.[i] ?? 0) > 0).map((i) => ({ i, teams: data.teamsPlaying![i] }));
  const light = nights.filter((n) => n.teams <= 10).map((n) => `${dayLabel(days[n.i].date)} (${n.teams} teams)`);
  const heavy = nights.filter((n) => n.teams >= 22).map((n) => `${dayLabel(days[n.i].date)} (${n.teams})`);
  const acts = rows.filter((r) => r.v.tone === 'act').length;

  return (
    <Panel
      title="Your schedule"
      sub={`${acts ? `${acts} streaming ${acts === 1 ? 'spot opens' : 'spots open'} before the week ends. ` : ''}${light.length ? `Light nights: ${light.join(', ')}, so pickups who play then usually start. ` : ''}${heavy.length ? `Busy: ${heavy.join(', ')}, your lineup is likely full.` : ''}`}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
              <th className="pb-2 font-medium">Player</th>
              {days.map((d, i) => (
                <th key={d.scoringPeriodId} className={`w-7 pb-2 text-center font-medium ${i < left[0] ? 'opacity-40' : ''}`}>{dayLabel(d.date).slice(0, 2)}</th>
              ))}
              <th className="pb-2 pl-2 text-right font-medium" title="Games next matchup week">Next</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ p, v, next }) => (
              <tr key={p.playerId} className={`border-t border-line align-top ${p.injured ? 'opacity-50' : ''}`}>
                <td className="py-1.5 pr-2">
                  <div className="flex items-center gap-2">
                    <Headshot id={p.playerId} name={p.name} size={28} />
                    <div className="min-w-0">
                      <div className="flex max-w-[14rem] items-center gap-1 sm:max-w-none">
                        <span className="truncate">{p.name}</span>
                        {p.nbaTeamAbbrev && <TeamLogo team={p.nbaTeamAbbrev} size={12} />}
                        <InjuryBadge s={p.status} />
                      </div>
                      <div className={`text-xs ${v.tone === 'act' ? 'font-medium text-accent' : v.tone === 'keep' ? 'text-fg' : 'text-muted'}`}>{v.text}</div>
                    </div>
                  </div>
                </td>
                {p.playsByDay.map((plays, i) => (
                  <td key={i} className={`py-1.5 text-center ${i < left[0] ? 'opacity-30' : ''}`}>
                    {plays ? <span className={`inline-block h-1.5 w-1.5 rounded-full ${open[i] > 0 && i >= left[0] ? 'bg-accent' : 'bg-fg'}`} /> : <span className="text-line">·</span>}
                  </td>
                ))}
                <td className={`py-1.5 pl-2 text-right tabular-nums ${(next ?? 0) >= 4 ? 'font-medium text-accent' : 'text-muted'}`}>{next ?? '–'}</td>
              </tr>
            ))}
            <tr className="border-t border-line text-xs text-muted">
              <td className="py-1.5">Open lineup spots</td>
              {open.map((n, i) => (
                <td key={i} className={`py-1.5 text-center tabular-nums ${i < left[0] ? 'opacity-30' : n > 0 ? 'font-medium text-accent' : ''}`}>{i < left[0] || !(data.teamsPlaying?.[i] ?? 1) ? '' : n}</td>
              ))}
              <td />
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">Green dot: a game on a day you have an open spot. Streaming spots are players outside your core.</p>
      {data.teams && (
        <details className="mt-4 border-t border-line pt-3">
          <summary className="cursor-pointer text-sm font-medium">Every team’s schedule this week</summary>
          <TeamGrid data={data} />
        </details>
      )}
    </Panel>
  );
}

/** Every NBA team's week: games left, back-to-backs, and next week, for picking whose players to stream. */
export function TeamGrid({ data }: { data: MatchupGamesComparison }) {
  const { days } = data;
  const left = days.map((d, i) => (d.scoringPeriodId >= data.today ? i : -1)).filter((i) => i >= 0);
  const teams = (data.teams ?? [])
    .map((t) => {
      const games = left.filter((i) => t.byDay[i]);
      const b2b = games.filter((i, k) => k > 0 && games[k - 1] === i - 1).map((i) => `${dayLabel(days[i - 1].date)}–${dayLabel(days[i].date)}`);
      return { ...t, games, b2b };
    })
    .sort((a, b) => b.games.length - a.games.length || (b.next ?? 0) - (a.next ?? 0) || a.abbrev.localeCompare(b.abbrev));
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
            <th className="pb-2 font-medium">Team</th>
            <th className="pb-2 text-right font-medium">Left</th>
            {days.map((d, i) => (
              <th key={d.scoringPeriodId} className={`w-7 pb-2 text-center font-medium ${i < left[0] ? 'opacity-40' : ''}`}>{dayLabel(d.date).slice(0, 2)}</th>
            ))}
            <th className="pb-2 pl-2 text-right font-medium">Next</th>
            <th className="hidden pb-2 pl-3 font-medium sm:table-cell">Back-to-back</th>
          </tr>
        </thead>
        <tbody>
          {teams.map((t) => (
            <tr key={t.abbrev} className="border-t border-line">
              <td className="py-1"><span className="inline-flex items-center gap-1"><TeamLogo team={t.abbrev} size={14} />{t.abbrev}</span></td>
              <td className={`py-1 text-right tabular-nums font-medium ${t.games.length >= 4 ? 'text-accent' : t.games.length <= 1 ? 'text-muted' : ''}`}>{t.games.length}</td>
              {t.byDay.map((g, i) => (
                <td key={i} className={`py-1 text-center ${i < left[0] ? 'opacity-30' : ''}`}>{g ? <span className="inline-block h-1.5 w-1.5 rounded-full bg-fg" /> : <span className="text-line">·</span>}</td>
              ))}
              <td className={`py-1 pl-2 text-right tabular-nums ${(t.next ?? 0) >= 4 ? 'font-medium text-accent' : 'text-muted'}`}>{t.next ?? '–'}</td>
              <td className="hidden py-1 pl-3 text-xs text-muted sm:table-cell">{t.b2b.join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
