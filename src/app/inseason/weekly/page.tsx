'use client';

import { MatchupGamesPanel, type MovesResponse } from '../MovesPanel';
import { SchedulePanel, TeamGrid } from '../SchedulePanel';
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
      {data.plan && <SchedulePanel data={games} plan={data.plan} teams={false} />}
      <MatchupGamesPanel data={games} />
      {games.teams && (
        <Panel title="NBA schedule this week" sub="Pick up players from teams at the top: more games left means more points this week. Next week is how many games they play in next week’s matchup, if you keep him.">
          <TeamGrid data={games} />
        </Panel>
      )}
    </div>
  );
}
