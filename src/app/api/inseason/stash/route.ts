/**
 * API Route: /api/inseason/stash
 * Injured free agents worth holding for when they're back, with ESPN's return estimates.
 */

import { leagueGet } from '@/lib/inseason/routeContext';
import { buildStash } from '@/lib/inseason/stash';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const GET = leagueGet('stash', buildStash);
