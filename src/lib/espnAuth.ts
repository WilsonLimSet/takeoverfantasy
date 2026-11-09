"use client";

/**
 * Your ESPN login cookies for private leagues, kept only in this browser. Our API forwards them to
 * ESPN for each request and never stores them.
 */
const KEY = "cv.espnAuth";

interface EspnAuth { s2: string; swid: string }

export function getEspnAuth(): EspnAuth | null {
  try {
    const raw = localStorage.getItem(KEY);
    const a = raw ? (JSON.parse(raw) as EspnAuth) : null;
    return a?.s2 && a?.swid ? a : null;
  } catch {
    return null;
  }
}

export function setEspnAuth(a: EspnAuth | null) {
  try {
    if (a) localStorage.setItem(KEY, JSON.stringify(a)); else localStorage.removeItem(KEY);
  } catch { /* ignore */ }
}

/** Headers to send with calls to our ESPN-backed API routes. */
export function espnHeaders(): Record<string, string> {
  const a = getEspnAuth();
  return a ? { "x-espn-s2": a.s2, "x-espn-swid": a.swid } : {};
}
