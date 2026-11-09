import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { AUTH_ON } from "./supabase/env";
import { supabaseServer } from "./supabase/server";
import { kvStore } from "./inseason/storage";

/**
 * Stateless in-season pass: a week pass (7 days) or a season pass (through SEASON_END).
 *  - cookie `cv_pass` = base64url(email|expiryMs).signature
 *  - license key = first 12 chars of HMAC(email) (lets a buyer unlock on another device)
 * Set CV_SECRET in production.
 */
const SECRET = process.env.CV_SECRET ?? (process.env.VERCEL_ENV === "production" ? "" : "dev-secret-change-me");
// Without a real secret anyone could forge a pass, so production refuses to sign or accept one.
if (!SECRET) console.error("[auth] CV_SECRET is not set; season passes are disabled.");
export const PASS_COOKIE = "cv_pass";
export const SEASON_END = Date.parse(process.env.CV_PASS_EXPIRES ?? "2027-07-01T00:00:00Z");
export const FREE_LIMIT = Number(process.env.CV_FREE_LIMIT ?? 50);
/**
 * The in-season paywall only applies once the Stripe links are set up (STRIPE_WEEK_LINK and
 * STRIPE_SEASON_LINK) or it is forced with CV_PAYWALL=on. The draft kit is always free.
 */
export const PAYWALL_ON = !!process.env.STRIPE_SEASON_LINK || process.env.CV_PAYWALL === "on";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The two Stripe Payment Links, with each one's checkout prefilled with the buyer's email and a
 * promotion code: a creator's code from their link, or STRIPE_UPGRADE_PROMO on the season link for
 * someone already on a week pass. (The links must allow promotion codes in Stripe.)
 */
export function planLinks(email?: string, opts: { promo?: string | null; upgrading?: boolean } = {}) {
  const link = (url: string | undefined, promo?: string | null) => {
    if (!url) return null;
    const q = new URLSearchParams();
    if (email) q.set("prefilled_email", email);
    if (promo) q.set("prefilled_promo_code", promo);
    return q.size ? `${url}?${q}` : url;
  };
  const upgrade = opts.upgrading ? process.env.STRIPE_UPGRADE_PROMO : null;
  // The weekly subscription replaces the one-time week pass once its link is set.
  const weekly = !!process.env.STRIPE_WEEKLY_LINK;
  return {
    week: link(process.env.STRIPE_WEEKLY_LINK ?? process.env.STRIPE_WEEK_LINK, opts.promo),
    season: link(process.env.STRIPE_SEASON_LINK, upgrade || opts.promo),
    weekly,
  };
}

type Checkout = { payment_link?: string | null; created?: number; subscription?: string | null };

/** A checkout from the weekly subscription link (STRIPE_WEEKLY_LINK_ID): access runs while the subscription does. */
export const isWeeklyCheckout = (s: Checkout) =>
  !!s.subscription && !!s.payment_link && s.payment_link === process.env.STRIPE_WEEKLY_LINK_ID;

const PAST_DUE_GRACE_MS = 2 * 24 * 60 * 60 * 1000;

export interface SubscriptionState { id: string; until: number; renews: boolean; status: string }

/** Until when a subscription gives access (the end of the paid period, 0 once it has ended) and whether it renews. Throws on Stripe errors. */
export async function subscriptionState(id: string): Promise<SubscriptionState> {
  const sk = process.env.STRIPE_SECRET_KEY;
  if (!sk) throw new Error("STRIPE_SECRET_KEY is not set");
  const r = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${sk}` }, cache: "no-store" });
  if (!r.ok) throw new Error(`Stripe subscription ${id}: ${r.status}`);
  const sub = await r.json();
  // Newer API versions keep the period on the subscription item.
  const item = sub.items?.data?.[0];
  const end = Number(sub.current_period_end ?? item?.current_period_end ?? 0) * 1000;
  const start = Number(sub.current_period_start ?? item?.current_period_start ?? 0) * 1000;
  // A failed renewal (past_due) has moved into a week nobody paid for: a short grace while Stripe retries the card.
  const until = sub.status === "active" || sub.status === "trialing" ? end : sub.status === "past_due" ? Math.min(end, start + PAST_DUE_GRACE_MS) : 0;
  return { id, until, renews: until > Date.now() && !sub.cancel_at_period_end && !sub.cancel_at, status: String(sub.status) };
}

/** When a paid checkout's access ends, including the weekly subscription (asks Stripe for its period). */
export async function checkoutAccessEnd(s: Checkout): Promise<number | null> {
  if (isWeeklyCheckout(s)) return (await subscriptionState(s.subscription!)).until || null;
  return accessEnd(s);
}

/**
 * When a paid checkout's access ends: 7 days after a week pass, the end of the season for a
 * season pass (and the old draft pass), null for anything else on the Stripe account.
 */
function accessEnd(session: Checkout): number | null {
  const link = session.payment_link;
  if (!link) return null;
  if (link === process.env.STRIPE_WEEK_LINK_ID) return (session.created ?? 0) * 1000 + WEEK_MS;
  if (link === process.env.STRIPE_SEASON_LINK_ID || link === process.env.STRIPE_PAYMENT_LINK_ID) return SEASON_END;
  return null;
}

const sign = (s: string) => {
  if (!SECRET) throw new Error("CV_SECRET is not set");
  return createHmac("sha256", SECRET).update(s).digest("base64url");
};

function licenseKey(email: string) {
  const h = sign(`key:${email.trim().toLowerCase()}`).replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 12);
  return `${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}`;
}

export function checkLicense(email: string, key: string) {
  const a = Buffer.from(licenseKey(email)), b = Buffer.from(key.trim().toUpperCase());
  return a.length === b.length && timingSafeEqual(a, b);
}

export function makePass(email: string, until = SEASON_END) {
  const body = Buffer.from(`${email.trim().toLowerCase()}|${until}`).toString("base64url");
  return `${body}.${sign(body)}`;
}

function readPass(value: string | undefined): { email: string; until: number } | null {
  if (!value || !SECRET) return null;
  const [body, sig] = value.split(".");
  if (!body || !sig) return null;
  const good = Buffer.from(sign(body)), got = Buffer.from(sig);
  if (good.length !== got.length || !timingSafeEqual(good, got)) return null;
  // The expiry is after the last "|": an email can contain "|", and a bad expiry must never mean "no expiry".
  const text = Buffer.from(body, "base64url").toString();
  const cut = text.lastIndexOf("|");
  const email = text.slice(0, cut), until = Number(text.slice(cut + 1));
  if (cut <= 0 || !email || !Number.isFinite(until) || until < Date.now()) return null;
  return { email, until };
}

/** Emails that get Pro for free when they sign in (FRIEND_EMAILS, comma-separated). */
const friendEmails = () => new Set((process.env.FRIEND_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean));

const paidCache = new Map<string, { until: number; renews: boolean; at: number }>();
const PAID_CACHE_MAX = 5000;
/**
 * Until when this email has access from its Stripe purchases (0 if none). An active pass is
 * cached for an hour (never past its end), none for 10 minutes, and a Stripe error for a minute
 * (so an outage doesn't turn every request into a Stripe call).
 */
type Paid = { until: number; renews: boolean };
const lookups = new Map<string, Promise<Paid>>();
/** One Stripe lookup at a time per email: a burst of requests shares it. */
function paidUntilOnStripe(email: string): Promise<Paid> {
  let p = lookups.get(email);
  if (!p) {
    p = lookupStripe(email).finally(() => lookups.delete(email));
    lookups.set(email, p);
  }
  return p;
}

async function lookupStripe(email: string): Promise<Paid> {
  const none = { until: 0, renews: false };
  const sk = process.env.STRIPE_SECRET_KEY;
  if (!sk) return none;
  const now = Date.now();
  const hit = paidCache.get(email);
  const active = !!hit && hit.until > now;
  const ttl = active ? 60 * 60 * 1000 : 10 * 60 * 1000;
  if (hit && now - hit.at < ttl) return hit.until > now ? { until: hit.until, renews: hit.renews } : none;
  const remember = (until: number, renews: boolean, at = Date.now()) => {
    if (paidCache.size >= PAID_CACHE_MAX) paidCache.delete(paidCache.keys().next().value!);
    paidCache.set(email, { until, renews, at });
    return until > Date.now() ? { until, renews } : none;
  };
  // On an error, keep what we knew; retry in about a minute.
  const keep = () => remember(hit?.until ?? 0, hit?.renews ?? false, now - ttl + 60 * 1000);
  try {
    const q = new URLSearchParams({ "customer_details[email]": email, status: "complete", limit: "100" });
    const get = () => fetch(`https://api.stripe.com/v1/checkout/sessions?${q}`, { headers: { Authorization: `Bearer ${sk}` }, cache: "no-store" });
    let r = await get();
    // Stripe's rate limit (429): wait a moment and try again, twice.
    for (let i = 1; r.status === 429 && i <= 2; i++) {
      await new Promise((ok) => setTimeout(ok, 500 * i + Math.random() * 500));
      r = await get();
    }
    if (!r.ok) return keep();
    const j = (await r.json()) as { data?: (Checkout & { payment_status?: string })[] };
    // Passes stack: a week bought before the last one ends starts when that one ends.
    let until = 0, renews = false;
    for (const s of (j.data ?? []).filter((s) => s.payment_status === "paid").sort((a, b) => (a.created ?? 0) - (b.created ?? 0))) {
      // A subscription runs to the end of its paid period, renewals included.
      if (isWeeklyCheckout(s)) {
        const sub = await subscriptionState(s.subscription!);
        if (sub.until > until) { until = sub.until; renews = sub.renews; }
        continue;
      }
      const end = accessEnd(s);
      if (!end) continue;
      const start = (s.created ?? 0) * 1000;
      const next = end === SEASON_END ? Math.max(until, end) : Math.max(until, start) + (end - start);
      if (next > until) { until = next; renews = false; }
    }
    return remember(until, renews);
  } catch { return keep(); }
}

/** The signed-in account (Supabase), if auth is configured and the email is verified. */
export async function currentAccount(): Promise<{ email: string } | null> {
  if (!AUTH_ON) return null;
  try {
    const supabase = await supabaseServer();
    const { data } = await supabase.auth.getClaims();
    const email = (data?.claims?.email as string | undefined)?.toLowerCase();
    return email ? { email } : null;
  } catch { return null; }
}

type Pass = { email: string; via: "pass" | "friend" | "stripe"; until?: number; renews?: boolean };

/**
 * In-season access, from any of: the pass cookie (paid or comp code), a signed-in friend on
 * FRIEND_EMAILS, or a signed-in account whose email bought a pass on Stripe.
 */
export async function currentPass(): Promise<Pass | null> {
  const jar = await cookies();
  const pass = readPass(jar.get(PASS_COOKIE)?.value);
  if (pass) return { ...pass, via: "pass" };
  const account = await currentAccount();
  if (!account) return null;
  return accessFor(account.email);
}

/** Drop the cached Stripe answer for an email, after its subscription changes. */
export const forgetPaid = (email: string) => paidCache.delete(email.toLowerCase());

const linkedKey = (email: string) => `pass:linked:${email}`;

/**
 * A pass bought while signed in belongs to that account too, even if the buyer typed another email
 * at checkout, so their alerts and other devices keep working.
 */
export async function linkPassToAccount(email: string, until: number) {
  const kv = kvStore();
  const key = linkedKey(email.toLowerCase());
  const had = (await kv.get<number>(key).catch(() => null)) ?? 0;
  if (until > had) await kv.set(key, until);
  paidCache.delete(email.toLowerCase());
}

/** Access for an email without a browser (crons, Telegram): a friend, or a pass bought on Stripe. */
export async function accessFor(email: string): Promise<Pass | null> {
  const e = email.toLowerCase();
  if (friendEmails().has(e)) return { email: e, via: "friend" };
  const [stripe, linked] = await Promise.all([paidUntilOnStripe(e), kvStore().get<number>(linkedKey(e)).catch(() => null)]);
  const until = Math.max(stripe.until, linked && linked > Date.now() ? linked : 0);
  return until ? { email: e, via: "stripe", until, renews: stripe.renews && stripe.until >= until } : null;
}

export const passCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};

/** The league owner (OWNER_EMAILS): the in-season tools read the owner's league with the server's ESPN login. */
export async function isOwner(): Promise<boolean> {
  const owners = new Set((process.env.OWNER_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean));
  const account = await currentAccount();
  return !!account && owners.has(account.email);
}
