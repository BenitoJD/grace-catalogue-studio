import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { api, errorMessage, type Bootstrap } from '@/lib/api';

interface BootstrapContextValue {
  data: Bootstrap | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

const BootstrapContext = createContext<BootstrapContextValue | null>(null);

/**
 * Loads GET /api/bootstrap once for the whole app. Orders, the customer
 * picker and the material grid all read from this cache.
 */
export function BootstrapProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    requestId.current += 1;
    const currentRequest = requestId.current;
    setLoading(true);
    setError(null);
    try {
      const next = await api.bootstrap();
      if (!mounted.current || requestId.current !== currentRequest) {
        return;
      }
      setData(next);
    } catch (loadError) {
      if (!mounted.current || requestId.current !== currentRequest) {
        return;
      }
      setError(errorMessage(loadError));
    } finally {
      if (mounted.current && requestId.current === currentRequest) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    // First load on mount, the provider starts in the loading state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const value = useMemo<BootstrapContextValue>(
    () => ({ data, loading, error, reload: load }),
    [data, loading, error, load],
  );

  return <BootstrapContext.Provider value={value}>{children}</BootstrapContext.Provider>;
}

export function useBootstrap(): BootstrapContextValue {
  const context = useContext(BootstrapContext);
  if (!context) {
    throw new Error('useBootstrap must be used inside BootstrapProvider');
  }
  return context;
}
