"use client";

import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";

const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global { interface Window { google?: any } }

const sha256 = async (s: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))))
    .map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Google's own sign-in button (Google Identity Services). The account picker runs on our page,
 * so Google shows "takeoverfantasy.com" rather than the Supabase project domain. The ID token
 * is handed to Supabase with a nonce. Falls back to the redirect flow without a client ID.
 */
export function GoogleButton({ onDone, onError, fallback }: { onDone: () => void; onError: (m: string) => void; fallback: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  const init = useCallback(async () => {
    const g = window.google?.accounts?.id;
    if (!g || !box.current) return;
    const nonce = crypto.randomUUID();
    g.initialize({
      client_id: CLIENT_ID,
      nonce: await sha256(nonce),
      use_fedcm_for_button: true,
      callback: async ({ credential }: { credential: string }) => {
        const { error } = await (await import('@/lib/supabase/browser')).supabaseBrowser().auth.signInWithIdToken({ provider: "google", token: credential, nonce });
        if (error) onError(error.message); else onDone();
      },
    });
    g.renderButton(box.current, { theme: "outline", size: "large", shape: "pill", text: "continue_with", width: box.current.offsetWidth || 320 });
    setReady(true);
  }, [onDone, onError]);

  useEffect(() => { if (window.google?.accounts?.id) void init(); }, [init]);

  if (!CLIENT_ID) {
    return (
      <button onClick={fallback} className="flex w-full items-center justify-center gap-2 rounded-full border border-line bg-panel px-4 py-2 text-sm font-medium hover:border-fg/30 hover:bg-sunken">
        Continue with Google
      </button>
    );
  }
  return (
    <>
      <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" onLoad={() => void init()} />
      <div ref={box} className="flex min-h-[44px] w-full justify-center" />
      {!ready && <div className="-mt-[44px] h-[44px] w-full animate-pulse rounded-full bg-sunken" />}
    </>
  );
}
