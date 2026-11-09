import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LogoMark } from "@/components/Logo";
import { isOwner } from "@/lib/auth";
import { scorecard } from "@/lib/scorecard";
import { cardUrl, dailyCaption, dailyContent, easternDate, heroesCaption, newsAlerts, newsCaption, risersCaption, risersFallers, scheduleCaption, scheduleSpots, SITE, waiverHeroes, yesterday } from "@/lib/social";
import { CopyButton } from "./CopyButton";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Studio · Takeover Fantasy", robots: { index: false } };

function Post({ title, img, caption, file }: { title: string; img: string; caption: string; file: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-4 shadow-[0_1px_2px_rgba(25,25,25,0.04)]">
      <div className="mb-3 text-sm font-medium">{title}</div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={img} alt={title} loading="lazy" className="w-full rounded-lg border border-line" />
      <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-sunken p-3 text-xs leading-relaxed">{caption}</pre>
      <div className="mt-3 flex gap-2">
        <CopyButton text={caption} />
        <a href={img} download={file} className="btn-ghost">Download image</a>
      </div>
    </div>
  );
}

/**
 * Owner-only: today's ready-to-post social content. Each card is an image plus a caption; long-press
 * the image on a phone to save it, then paste the caption into Instagram, TikTok or X.
 */
export default async function Studio() {
  if (!(await isOwner())) notFound();
  const night = yesterday();
  // A server component rendered per request (force-dynamic): reading the clock here is fine.
  // eslint-disable-next-line react-hooks/purity
  const today = easternDate(Date.now());
  const [news, movers, schedule, card, heroes, daily] = await Promise.all([
    newsAlerts(8).catch(() => []),
    risersFallers(5).catch(() => null),
    scheduleSpots().catch(() => null),
    scorecard().catch(() => null),
    waiverHeroes(night, 5).catch(() => null),
    dailyContent(today).catch(() => null),
  ]);
  const slides = daily
    ? [`type=daily-cover&date=${today}`, ...(daily.heroes.list.length ? [`type=heroes&date=${daily.night}`] : []), ...(daily.movers.risers.length ? ["type=trending"] : []), ...(daily.injuries.length ? [`type=injuries&date=${today}`] : []), "type=cta"]
    : [];
  const img = (q: string) => cardUrl(q, false);
  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <Link href="/" className="flex items-center gap-2 text-sm font-semibold"><LogoMark size={20} /> Takeover Fantasy</Link>
      <h1 className="mt-6 text-3xl font-medium tracking-[-0.03em]">Studio</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Today&apos;s posts. The daily slideshow and breaking news go to Instagram and Threads through Postroom automatically, and to your Telegram; everything else here is for posting by hand. Every link points to {SITE.replace(/^https?:\/\//, "")}.
      </p>

      {daily && (
        <>
          <h2 className="mt-10 mb-4 text-lg font-medium">Today&apos;s waiver wire · daily slideshow</h2>
          <div className="flex snap-x gap-4 overflow-x-auto pb-2">
            {slides.map((q, i) => (
              <a key={q} href={cardUrl(q, false)} download={`daily-${today}-${i + 1}.png`} className="w-64 shrink-0 snap-start">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={cardUrl(q, false)} alt={`Slide ${i + 1}`} loading="lazy" className="w-full rounded-lg border border-line" />
              </a>
            ))}
          </div>
          <pre className="mt-3 max-w-2xl whitespace-pre-wrap rounded-lg bg-sunken p-3 text-xs leading-relaxed">{dailyCaption(daily)}</pre>
          <div className="mt-2"><CopyButton text={dailyCaption(daily)} /></div>
        </>
      )}

      <h2 className="mt-10 mb-4 text-lg font-medium">Breaking news</h2>
      {news.length ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {news.map((a) => (
            <Post key={a.key} title={`${a.label}: ${a.name}`} img={img(`type=news&player=${a.id}`)} caption={newsCaption(a)} file={`${a.name.replace(/\W+/g, "-")}.png`} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted">No fresh news on rostered players in the last two days.</p>
      )}

      <h2 className="mt-10 mb-4 text-lg font-medium">Daily and weekly</h2>
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {heroes && heroes.list.length > 0 && <Post title="Last night's waiver heroes" img={img(`type=heroes&date=${night}`)} caption={heroesCaption(heroes)} file={`heroes-${night}.png`} />}
        {movers && movers.risers.length > 0 && <Post title="Risers & fallers" img={img("type=trending")} caption={risersCaption(movers)} file="trending.png" />}
        {schedule && <Post title="Schedule" img={img("type=schedule")} caption={scheduleCaption(schedule)} file="schedule.png" />}
        {card && (
          <Post
            title={`Receipts, week ${card.week}${card.complete ? "" : " (in progress)"}`}
            img={img(`type=scorecard&week=${card.week}`)}
            caption={`Week ${card.week} receipts 🧾\n\nOur streamers: ${card.ours.fppg.toFixed(1)} fpts/g\nESPN's most added: ${card.espn.fppg.toFixed(1)} fpts/g\n\nEvery pick, every week: ${SITE.replace(/^https?:\/\//, "")}/scorecard\n#fantasybasketball #nbafantasy`}
            file={`receipts-week-${card.week}.png`}
          />
        )}
      </div>
    </main>
  );
}
