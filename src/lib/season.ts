/**
 * Season mode: from opening night until next year's draft season, the site leads with the
 * in-season tools instead of the draft kit. NEXT_PUBLIC_SEASON_MODE=season|draft forces either.
 */

/** Opening night of the regular season (US Eastern date). */
const SEASON_START = '2026-10-20';
/** When drafts start again and the draft kit should lead. */
const DRAFT_SEASON_START = '2027-09-01';

export function seasonMode(now = Date.now()): boolean {
  const forced = process.env.NEXT_PUBLIC_SEASON_MODE;
  if (forced === 'season') return true;
  if (forced === 'draft') return false;
  const today = new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  return today >= SEASON_START && today < DRAFT_SEASON_START;
}
