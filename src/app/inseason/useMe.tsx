'use client';

import { track } from '@vercel/analytics';
import { funnel } from '@/components/funnel';
import Link from 'next/link';
import { Skeleton, SkeletonRows } from '@/components/ui';
import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { AUTH_ON } from '@/lib/supabase/env';

export interface MeProfile {
  leagueId: string;
  seasonId: number;
  teamId: number;
  teamName?: string;
  leagueName?: string;
  core: number[];
  alerts: { email: boolean; telegram?: boolean; news?: boolean };
  telegram?: { username?: string } | null;
  hasLogin: boolean;
  lastRefreshAt?: number;
}

/** A league connected without an account (kept in a cookie until they sign in). */
export interface MeGuest {
  leagueId: string;
  teamId: number;
  teamName?: string;
  leagueName?: string;
  hasLogin: boolean;
}

export interface Me {
  signedIn: boolean;
  email?: string;
  guest?: MeGuest | null;
  /** Signed in without a league, with a league connected before signing in: offered to save. */
  pendingGuest?: MeGuest | null;
  pro?: boolean;
  profile?: MeProfile | null;
  emailAlerts?: boolean;
  /** Our Telegram bot's username, when Telegram alerts are switched on. */
  telegramBot?: string | null;
  /** When a paid pass ends (ms), null for friends, owners and comp codes. */
  passUntil?: number | null;
  /** The pass ends within two weeks (a week pass), so the header offers the season. */
  shortPass?: boolean;
  /** Stripe checkout links for the two passes (null until payments are set up). */
  plans?: { week: string | null; season: string | null; weekly?: boolean };
  /** On the weekly subscription and still renewing (passUntil is the next renewal). */
  renews?: boolean;
  /** Their referral link (a friend who buys through it gets a free week, and so do they). */
  referralUrl?: string | null;
}

const MeContext = createContext<{ me: Me | null; reload: () => Promise<void> }>({ me: null, reload: async () => {} });

/** The signed-in user and their connected league, loaded once for every in-season page. */
export function MeProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const reload = useCallback(async () => {
    try {
      const r = await fetch('/api/inseason/me', { cache: 'no-store' });
      const j = (await r.json()) as Me;
      claimCache(j.signedIn ? j.email : undefined);
      setMe(j);
    } catch {
      setMe({ signedIn: false });
    }
  }, []);
  useEffect(() => { reload(); }, [reload]);
  // Load the other tabs' data up front so switching to them is instant.
  useEffect(() => {
    if (!me?.profile && !me?.guest) return;
    loadCached(MOVES_URL);
    loadCached('/api/inseason/weekly-plan');
  }, [me?.profile, me?.guest]);
  return <MeContext.Provider value={{ me, reload }}>{children}</MeContext.Provider>;
}

export const useMeContext = () => useContext(MeContext);

// ============ Shared API cache ============
// Every tab reads the same league data, so keep each response in memory: switching tabs shows it
// at once and refetches quietly in the background when it's more than a minute old.

const FRESH_MS = 60_000;
type Entry = { data?: unknown; at: number; inflight?: Promise<void> };
const cache = new Map<string, Entry>();

// The last responses also live in localStorage, so a reload or a visit tomorrow shows them at
// once while fresh ones load. They belong to one account: cleared on sign-out or a new sign-in.
const STORE = 'tf.cache:';
const OWNER = 'tf.cache.owner';
function stored(url: string): Entry | undefined {
  try {
    const raw = localStorage.getItem(STORE + url);
    return raw ? (JSON.parse(raw) as Entry) : undefined;
  } catch { return undefined; }
}
function store(url: string, e: Entry) {
  try { localStorage.setItem(STORE + url, JSON.stringify({ data: e.data, at: e.at })); } catch { /* full or blocked */ }
}
export function clearCached() {
  cache.clear();
  checked.clear();
  ownerConfirmed = false;
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(STORE) || k === OWNER) localStorage.removeItem(k);
  } catch { /* ignore */ }
}
/**
 * Saved data is only read once /me has confirmed it belongs to the signed-in account, so on a
 * shared browser nobody sees the previous user's league, even for a moment.
 */
let ownerConfirmed = false;
function claimCache(email: string | undefined) {
  try {
    if (!email || localStorage.getItem(OWNER) !== email) {
      clearCached();
      if (email) localStorage.setItem(OWNER, email);
    }
  } catch { /* ignore */ }
  ownerConfirmed = !!email;
  notify();
}
/** URLs already looked up in localStorage since the owner was confirmed. */
const checked = new Set<string>();
const entry = (url: string): Entry | undefined => {
  const e = cache.get(url);
  // A page may have started loading before /me answered; fill its empty entry from the saved copy.
  if (e?.data === undefined && ownerConfirmed && !checked.has(url) && typeof window !== 'undefined') {
    checked.add(url);
    const s = stored(url);
    if (s) {
      const filled = e ? Object.assign(e, { data: s.data, at: s.at }) : s;
      cache.set(url, filled);
      return filled;
    }
  }
  return e;
};
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** Fetch an API response into the cache (one request at a time per URL). */
export function loadCached(url: string, force = false): Promise<void> {
  const e = entry(url) ?? { at: 0 };
  cache.set(url, e);
  if (e.inflight) return e.inflight;
  if (!force && e.data !== undefined && Date.now() - e.at < FRESH_MS) return Promise.resolve();
  e.inflight = fetch(url, { cache: 'no-store' })
    .then((r) => r.json())
    .catch(() => ({ success: false, error: 'Network error' }))
    .then((data) => {
      const next = { data, at: Date.now() };
      cache.set(url, next);
      if (ownerConfirmed && (data as { success?: boolean })?.success) store(url, next);
      // Lost access (pass ended, signed out): drop the saved copy so it doesn't flash next time.
      else if ((data as { needs?: string })?.needs) try { localStorage.removeItem(STORE + url); } catch { /* ignore */ }
      notify();
    });
  return e.inflight;
}

/** Forget cached responses (after a change that alters them, like saving core players). */
export function invalidateCached(...urls: string[]) {
  for (const u of urls) cache.delete(u);
  urls.forEach((u) => loadCached(u, true));
}

/** The cached response for a URL (null until the first load), revalidated when stale. */
export function useCached<T>(url: string | null): { data: T | null; reload: () => Promise<void> } {
  const data = useSyncExternalStore(subscribe, () => (url ? (entry(url)?.data as T | undefined) ?? null : null), () => null);
  useEffect(() => { if (url) loadCached(url); }, [url]);
  const reload = useCallback(() => (url ? loadCached(url, true) : Promise.resolve()), [url]);
  return { data, reload };
}

export const MOVES_URL = '/api/inseason/moves';

// ============ Shared bits, styled like the draft kit ============

export function Panel({ title, sub, right, children, className = '' }: {
  title?: React.ReactNode; sub?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; className?: string;
}) {
  return (
    <section className={`animate-fade-up rounded-xl border border-line bg-panel shadow-[0_1px_2px_rgba(25,25,25,0.04)] ${className}`}>
      {(title || right) && (
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
          <div>
            <h2 className="text-sm font-medium tracking-tight">{title}</h2>
            {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
          </div>
          {right && <div className="text-xs text-muted">{right}</div>}
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

/**
 * Placeholder while a tab's data loads, shaped like what's coming: "week" has the stat strip and
 * a moves panel beside a side column; "table" is one long list.
 */
export function Loading({ what, kind = 'table' }: { what: string; kind?: 'week' | 'table' }) {
  const panel = (rows: number, cls = '') => (
    <div className={`rounded-xl border border-line bg-panel p-4 shadow-[0_1px_2px_rgba(25,25,25,0.04)] ${cls}`}>
      <Skeleton className="mb-1 h-3.5 w-36" />
      <Skeleton className="mb-3 h-2.5 w-56" />
      <SkeletonRows rows={rows} />
    </div>
  );
  return (
    <div role="status" aria-label={`Loading ${what}`} className="space-y-4">
      {kind === 'week' ? (
        <>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="space-y-2"><Skeleton className="h-7 w-52" /><Skeleton className="h-3 w-64" /></div>
            <div className="grid w-full max-w-xl grid-cols-3 gap-px overflow-hidden rounded-xl border border-line bg-line">
              {[0, 1, 2].map((i) => <div key={i} className="space-y-2 bg-panel px-4 py-4"><Skeleton className="mx-auto h-6 w-16" /><Skeleton className="mx-auto h-2.5 w-24" /></div>)}
            </div>
          </div>
          <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">{panel(3)}{panel(5)}</div>
        </>
      ) : (
        panel(8)
      )}
    </div>
  );
}

export function ErrorBox({ children }: { children: React.ReactNode }) {
  return <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-700">{children}</div>;
}

export function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

function PlanCard({ href, name, price, note, fine, strong }: { href: string; name: string; price: string; note: string; fine: string; strong?: boolean }) {
  return (
    <a
      href={href}
      onClick={() => { track('checkout_click', { plan: strong ? 'season' : 'week' }); funnel('checkout_click'); }}
      className={`block rounded-xl border p-4 transition-shadow hover:shadow-[0_8px_30px_rgba(25,25,25,0.08)] ${strong ? 'border-ink' : 'border-line'}`}
    >
      <div className="text-sm font-medium">{name}</div>
      <div className="mt-1 text-3xl font-medium tracking-tight">{price}</div>
      <div className="mt-1 text-xs text-muted">{note} {fine}</div>
      <div className={`mt-4 rounded-full py-1.5 text-center text-sm font-medium ${strong ? 'bg-ink text-white' : 'border border-line'}`}>
        {strong ? 'Get the season' : 'Try a week'}
      </div>
    </a>
  );
}

/** What to show instead of the tools: sign in, upgrade, or connect a league. */
export function Gate({ needs }: { needs: 'signin' | 'pro' | 'connect' }) {
  const { me, reload } = useMeContext();
  // Back from Stripe while Stripe couldn't confirm the payment: say so instead of asking again.
  const [unlock, setUnlock] = useState<string | null>(null);
  useEffect(() => { setUnlock(new URLSearchParams(location.search).get('unlock')); }, []);
  const notice =
    unlock === 'pending'
      ? { title: 'Confirming your payment', body: 'Stripe is slow to confirm right now. Don’t pay again: refresh in a minute and your pass will be here.' }
      : unlock === 'used'
        ? { title: 'This payment is already unlocked', body: 'It was used on another browser. Sign in with the email you paid with and your pass works here too.' }
        : null;
  if (needs === 'pro' && notice) {
    return (
      <section className="rounded-xl border border-line bg-panel px-6 py-10 sm:px-10">
        <h1 className="text-2xl font-medium tracking-[-0.03em]">{notice.title}</h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">{notice.body}</p>
        <button onClick={() => location.reload()} className="mt-5 rounded-full bg-ink px-5 py-2 text-sm font-medium text-white hover:bg-ink/85">Refresh</button>
      </section>
    );
  }
  if (needs === 'connect' && me?.pendingGuest) return <ClaimGuest guest={me.pendingGuest} onDone={async () => { await reload(); invalidateCached(MOVES_URL); }} />;
  const copy = {
    signin: {
      title: 'See your best move this week, free',
      body: 'Paste your ESPN team link and we’ll show what this week’s add/drops would gain you, and the best one. No account needed.',
    },
    pro: {
      title: 'Let Takeover manage your week',
      body: 'Every morning: the add/drops that win you the most points, the day to make each one, a lineup check before lock, and alerts by email or Telegram. Try a week; if it earns its keep, get the season.',
    },
    connect: {
      title: 'Connect your ESPN league',
      body: 'Paste your ESPN team link and pick your team. It takes a minute.',
    },
  }[needs];
  return (
    <section className="rounded-xl border border-line bg-panel px-6 py-10 shadow-[0_1px_2px_rgba(25,25,25,0.04)] sm:px-10">
      <h1 className="text-2xl font-medium leading-tight tracking-[-0.03em] sm:text-3xl">{copy.title}</h1>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">{copy.body}</p>
      <div className="mt-5">
        {needs === 'signin' && (
          <div className="flex flex-wrap items-center gap-4">
            <Link href="/inseason/connect" className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-white hover:bg-ink/85">
              See your best move →
            </Link>
            <Link href="/login?next=/inseason" className="text-sm text-muted underline-offset-2 hover:text-fg hover:underline">
              Already have an account? Sign in
            </Link>
          </div>
        )}
        {needs === 'connect' && (
          <Link href="/inseason/connect" className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-white hover:bg-ink/85">
            Connect league
          </Link>
        )}
        {needs === 'pro' &&
          (me?.plans?.week || me?.plans?.season ? (
            <div className="grid max-w-xl gap-3 sm:grid-cols-2">
              {me.plans.week && (me.plans.weekly
                ? <PlanCard href={me.plans.week} name="Weekly" price="$5/wk" note="Try it on a real matchup." fine="Renews weekly, cancel anytime." />
                : <PlanCard href={me.plans.week} name="Week pass" price="$5" note="7 days. Try it on a real matchup." fine="One payment, no auto-renew." />)}
              {me.plans.season && <PlanCard href={me.plans.season} name="Season pass" price="$39" note="Through the 2026-27 playoffs." fine="One payment, no auto-renew." strong />}
            </div>
          ) : (
            <span className="text-sm text-muted">Payments aren’t switched on yet.</span>
          ))}
      </div>
    </section>
  );
}

/** Where an email sign-in link lands: back here, checked again by the callback. */
const signInCallback = (next: string) => `${location.origin}/auth/callback?next=${encodeURIComponent(next)}`;

/**
 * For a guest league: sign in by email (or Google on the sign-in page) to keep the league and get
 * alerts. The guest league becomes the account's profile on the first visit after signing in.
 */
export function SaveLeague({ next = '/inseason/connect#alerts', compact }: { next?: string; compact?: boolean }) {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [msg, setMsg] = useState<string | null>(null);
  if (!AUTH_ON) return null;
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setState('sending');
    const { error } = await (await import('@/lib/supabase/browser')).supabaseBrowser().auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: signInCallback(next) } });
    if (error) { setState('error'); setMsg(error.message); return; }
    setState('sent');
    track('save_league_email');
  };
  return (
    <Panel
      title="Save your league and get alerts"
      sub={compact ? undefined : 'Enter your email: we’ll keep your league and send injury alerts with the pickup, free. No password.'}
    >
      {state === 'sent' ? (
        <p className="text-sm">Check <b>{email}</b> for a sign-in link. Open it on this device and your league is saved.</p>
      ) : (
        <form onSubmit={send} className="flex max-w-xl flex-wrap gap-2">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            aria-label="Your email"
            className="input min-w-0 flex-1 basis-56 py-1.5"
          />
          <button disabled={state === 'sending'} className="btn-accent shrink-0 px-4 py-1.5 text-sm">
            {state === 'sending' ? 'Sending…' : 'Save my league'}
          </button>
        </form>
      )}
      {state === 'error' && <p className="mt-2 text-xs text-red-700">{msg ?? 'Something went wrong.'}</p>}
      {state !== 'sent' && (
        <p className="mt-2 text-xs text-muted">
          Or <Link href={`/login?next=${encodeURIComponent(next)}`} className="underline hover:text-fg">sign in with Google</Link>.
        </p>
      )}
    </Panel>
  );
}

/**
 * Signed in with a league connected before signing in: save it to the account with one click. It's
 * never saved without asking, so a league planted by another site can't end up in someone's account.
 */
export function ClaimGuest({ guest, onDone }: { guest: MeGuest; onDone: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (action: 'claim-guest' | 'discard-guest') => {
    setBusy(true); setError(null);
    const j = await fetch('/api/inseason/me', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) })
      .then((r) => r.json()).catch(() => ({ success: false, error: 'Network error' }));
    setBusy(false);
    if (!j.success) { setError(j.error ?? 'That didn’t work. Try again.'); return; }
    if (action === 'claim-guest') track('guest_league_saved');
    await onDone();
  };
  return (
    <Panel title="Save this league to your account?" sub="You connected it before signing in.">
      <p className="text-sm">
        <span className="font-medium">{guest.teamName ?? `Team ${guest.teamId}`}</span>
        <span className="text-muted"> · {guest.leagueName || `League ${guest.leagueId}`}{guest.hasLogin ? ' · private league' : ''}</span>
      </p>
      {error && <div className="mt-3"><ErrorBox>{error}</ErrorBox></div>}
      <div className="mt-4 flex flex-wrap gap-2">
        <button className="btn-accent px-4 py-1.5 text-sm" disabled={busy} onClick={() => act('claim-guest')}>{busy ? 'Saving…' : 'Save this league'}</button>
        <button className="btn-ghost px-4 py-1.5 text-sm" disabled={busy} onClick={() => act('discard-guest')}>Use a different league</button>
      </div>
    </Panel>
  );
}
