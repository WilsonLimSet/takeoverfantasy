"use client";

import { createContext, useContext } from "react";
import type { Valued } from "@/lib/engine";

/** Kept apart from PlayerSheet so pages that only show names (ui.tsx) don't load the whole panel. */
export const PlayerSheetCtx = createContext<((v: Valued) => void) | null>(null);

/** Opens the player profile panel; null outside the provider. */
export const usePlayerSheet = () => useContext(PlayerSheetCtx);
