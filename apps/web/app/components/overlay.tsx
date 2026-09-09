'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';

/**
 * One shared bit of state: is a full-screen media surface open?
 *
 * The orb lives in the root layout and the viewer lives deep inside the
 * gallery, so they cannot talk through props. This is the whole channel between
 * them — deliberately a boolean and nothing more.
 */
type OverlayValue = {
  mediaOpen: boolean;
  setMediaOpen: (open: boolean) => void;
};

const OverlayContext = createContext<OverlayValue>({
  mediaOpen: false,
  setMediaOpen: () => {},
});

export function OverlayProvider({ children }: { children: React.ReactNode }) {
  const [mediaOpen, setOpen] = useState(false);
  const setMediaOpen = useCallback((open: boolean) => setOpen(open), []);
  const value = useMemo(() => ({ mediaOpen, setMediaOpen }), [mediaOpen, setMediaOpen]);
  return <OverlayContext.Provider value={value}>{children}</OverlayContext.Provider>;
}

export function useOverlay(): OverlayValue {
  return useContext(OverlayContext);
}
