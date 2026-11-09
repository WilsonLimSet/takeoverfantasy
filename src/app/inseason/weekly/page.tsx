'use client';

import { MatchupGamesPanel, type MovesResponse } from '../MovesPanel';
import { TeamGrid } from '../SchedulePanel';
import { Gate, isGated, Loading, MOVES_URL, Panel, useCached } from '../useMe';

/** Games in your matchup, then every NBA team's week. Read from the moves data This week already loads. */
export default function SchedulePage() {
  const { data } = useCached<MovesResponse>(MOVES_URL);
  if (!data) return <Loading what="the schedule" />;
  if (isGated(data.needs)) return <Gate needs={data.needs} />;
  const games = data.matchupGames;
  if (!data.success || !games) {
    return <Panel title="Schedule"><p className="text-sm text-muted">{data.error ?? 'No schedule yet. Refresh on This week.'}</p></Panel>;
  }
  return (
    <div className="space-y-5">
      <MatchupGamesPanel data={games} />
      {games.teams && (
        <Panel title="NBA schedule this week" sub="Teams with the most games left are where streamers come from. Back-to-backs and next week’s games help time a pickup.">
          <TeamGrid data={games} />
        </Panel>
      )}
    </div>
  );
}
