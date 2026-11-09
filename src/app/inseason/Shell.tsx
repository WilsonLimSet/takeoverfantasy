'use client';

import { track } from '@vercel/analytics';
import { funnel } from '@/components/funnel';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LogoMark } from '@/components/Logo';
import { clearCached, loadCached, MeProvider, MOVES_URL, ROTATION_URL, useMeContext } from './useMe';

/** Draft kit tabs live inside /draft, so remember which one to open before going there. */
const DRAFT_TABS = [
  { id: 'kit', label: 'Rankings' },
  { id: 'mock', label: 'Mock Draft' },
  { id: 'draft', label: 'Live Draft' },
  { id: 'news', label: 'News' },
];

/** Each tab and the data it shows, loaded when the tab is hovered or touched so the switch is instant. */
const VIEWS = [
  { href: '/inseason', label: 'This week', data: [MOVES_URL, '/api/inseason/briefing', ROTATION_URL] },
  { href: '/inseason/waivers', label: 'Free agents', data: [MOVES_URL, ROTATION_URL] },
  { href: '/inseason/stash', label: 'Injured stash', data: ['/api/inseason/stash'] },
  { href: '/inseason/trades', label: 'Trades', data: ['/api/inseason/trades'] },
  { href: '/inseason/weekly', label: 'Schedule', data: [MOVES_URL] },
  { href: '/inseason/connect', label: 'My league', data: [MOVES_URL] },
];

function Header({ season }: { season: boolean }) {
  const { me } = useMeContext();
  const openDraftTab = (id: string) => {
    try { localStorage.setItem('cv.tab', JSON.stringify(id)); } catch { /* ignore */ }
  };
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-bg/90 backdrop-blur print:hidden">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
        <Link href="/" className="flex items-center gap-2" title="Takeover Fantasy home">
          <LogoMark size={22} />
          <span className="text-base font-semibold tracking-tight">Takeover Fantasy</span>
        </Link>
        <nav className="no-scrollbar -mx-1 flex max-w-full gap-1 overflow-x-auto px-1">
          {season ? (
            // During the season: in-season first, news, and the draft kit behind one link.
            <>
              <span className="whitespace-nowrap rounded-full bg-sunken px-3 py-1 text-sm font-medium text-fg">In-season</span>
              {[{ id: 'news', label: 'News' }, { id: 'kit', label: 'Draft kit' }].map((t) => (
                <Link
                  key={t.id}
                  href="/draft"
                  onClick={() => openDraftTab(t.id)}
                  className="whitespace-nowrap rounded-full px-3 py-1 text-sm text-muted hover:text-fg"
                >
                  {t.label}
                </Link>
              ))}
            </>
          ) : (
            <>
              {DRAFT_TABS.map((t) => (
                <Link
                  key={t.id}
                  href="/draft"
                  onClick={() => openDraftTab(t.id)}
                  className="whitespace-nowrap rounded-full px-3 py-1 text-sm text-muted hover:text-fg"
                >
                  {t.label}
                </Link>
              ))}
              <span className="whitespace-nowrap rounded-full bg-sunken px-3 py-1 text-sm font-medium text-fg">In-season</span>
            </>
          )}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-xs text-muted">
          {(me?.profile ?? me?.guest) && <span className="hidden sm:inline">{(me.profile ?? me.guest)?.teamName}</span>}
          {/* A week pass says when it ends, with the season one click away. */}
          {me?.passUntil && me.shortPass && (
            <span className="whitespace-nowrap">
              {me.renews ? 'Renews' : 'Pass ends'} {new Date(me.passUntil).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
              {me.plans?.season && <> · <a href={me.plans.season} onClick={() => { track('checkout_click', { plan: 'upgrade' }); funnel('checkout_click'); }} className="font-medium text-fg underline-offset-2 hover:underline">Get the season</a></>}
            </span>
          )}
          {me?.signedIn ? (
            <form action="/auth/signout" method="post" onSubmit={clearCached} className="flex items-center gap-2">
              <span className="hidden max-w-[12rem] truncate sm:inline" title={me.email}>{me.email}</span>
              <button className="whitespace-nowrap hover:text-fg">Sign out</button>
            </form>
          ) : me ? (
            <Link href="/login?next=/inseason" className="shrink-0 whitespace-nowrap rounded-full border border-line px-3 py-1 font-medium text-fg hover:border-fg/30 hover:bg-sunken">
              Sign in
            </Link>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function SubNav() {
  const path = usePathname();
  const { me } = useMeContext();
  // Only for someone with a league: otherwise every call would just answer "sign in".
  const warm = (urls: string[]) => { if (me?.profile ?? me?.guest) urls.forEach((u) => loadCached(u)); };
  return (
    <div className="no-scrollbar mb-5 inline-flex max-w-full overflow-x-auto rounded-full border border-line bg-panel p-0.5 text-[13px] sm:text-sm">
      {VIEWS.map((v) => (
        <Link
          key={v.href}
          href={v.href}
          onPointerEnter={() => warm(v.data)}
          onFocus={() => warm(v.data)}
          className={`whitespace-nowrap rounded-full px-2.5 py-1 sm:px-3 ${path === v.href ? 'bg-sunken font-medium text-fg' : 'text-muted hover:text-fg'}`}
        >
          {v.label}
        </Link>
      ))}
    </div>
  );
}

export function InseasonShell({ children, season = false }: { children: React.ReactNode; season?: boolean }) {
  return (
    <MeProvider>
      <div className="min-h-screen">
        <Header season={season} />
        <main className="mx-auto max-w-7xl px-4 py-5">
          <SubNav />
          {children}
        </main>
      </div>
    </MeProvider>
  );
}
