import { createHmac } from "node:crypto";
import { accessFor, linkPassToAccount } from "./auth";
import { kvStore } from "./inseason/storage";

/**
 * Referrals and creator codes, both carried in from links by the proxy as cookies:
 *  - ?ref=CODE  (a user's referral link): when the visitor buys any pass, both get a free week.
 *  - ?code=NAME (a creator's Stripe promotion code): prefilled at checkout, so the discount applies
 *    and Stripe's dashboard counts each creator's sales.
 */

export const REF_COOKIE = "tf_ref";
export const PROMO_COOKIE = "tf_promo";
const REFERRAL_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;
const refKey = (code: string) => `ref:code:${code}`;

/** A user's referral code: short, stable, and not guessable from their email. */
function referralCode(email: string): string {
  const secret = process.env.CV_SECRET ?? "dev-secret-change-me";
  return createHmac("sha256", secret).update(`ref:${email.toLowerCase()}`).digest("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
}

/** The code for an account, saved so a purchase can find who referred it. */
export async function ensureReferralCode(email: string): Promise<string> {
  const code = referralCode(email);
  const kv = kvStore();
  if (!(await kv.get(refKey(code)))) await kv.set(refKey(code), email.toLowerCase());
  return code;
}

export const cleanCode = (v: string | null | undefined) => (v ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || null;

/** Most free weeks one person can earn from referrals in a season. */
const MAX_REWARDS = 10;

/**
 * A referred purchase: the referrer gets a week added to their access, once per buyer. Returns
 * the buyer's bonus days (0 when there's no valid referral). The checkout email is free text, so
 * a purchase made while signed in as the referrer never counts, and rewards are capped per referrer.
 */
export async function rewardReferral(code: string | null, buyer: string, signedIn: string | null): Promise<number> {
  if (!code) return 0;
  const kv = kvStore();
  const referrer = await kv.get<string>(refKey(code));
  const b = buyer.toLowerCase();
  if (!referrer || referrer === b || referrer === signedIn?.toLowerCase()) return 0;
  if (!(await kv.claim(`ref:rewarded:${b}`, { referrer, at: Date.now() }))) return 0;
  // One atomic claim per reward slot, so simultaneous purchases can't push past the cap.
  let slot = false;
  for (let n = 0; n < MAX_REWARDS && !slot; n++) slot = await kv.claim(`ref:slot:${referrer}:${n}`, b);
  if (!slot) return 0;
  const current = (await accessFor(referrer))?.until ?? 0;
  await linkPassToAccount(referrer, Math.max(current, Date.now()) + REFERRAL_DAYS * DAY);
  return REFERRAL_DAYS;
}
