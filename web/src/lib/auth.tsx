/*
 * auth.tsx — authentication state + actions for the whole app.
 *
 * Bootstraps from GET /api/auth/me (server-side session is the source of truth —
 * we never store a token client-side). Exposes login/logout. Installs a global
 * 401 handler so any expired-session API call flips us back to the login screen
 * WITHOUT a hard reload (preserving the SPA + any unsaved form state the user
 * can still see).
 *
 * SECURITY: the only auth credential is the httpOnly session cookie managed by
 * the server. This module never touches localStorage and never holds a password.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { api } from '../api/client';
import { setUnauthorizedHandler } from '../api/http';
import { ApiError } from '../api/ApiError';

type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  status: AuthStatus;
  user: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Set by the global 401 handler; cleared on successful login. */
  expired: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const mounted = useRef(true);

  // Bootstrap: ask the server whether we already have a valid session.
  useEffect(() => {
    mounted.current = true;
    (async () => {
      try {
        const me = await api.auth.me();
        if (!mounted.current) return;
        if (me.authenticated) {
          setUser(me.user);
          setStatus('authenticated');
        } else {
          setStatus('anonymous');
        }
      } catch {
        // /me is safe to call unauthenticated; a failure here means the control
        // plane is unreachable. Treat as anonymous so the login screen shows
        // (it will surface the network error on the next attempt).
        if (mounted.current) setStatus('anonymous');
      }
    })();
    return () => {
      mounted.current = false;
    };
  }, []);

  // Global 401 handler: an authenticated call that comes back 401 means the
  // session expired server-side. Flip to anonymous + mark expired so the login
  // screen can explain why the user is back here.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setStatus((prev) => {
        if (prev === 'authenticated') {
          setExpired(true);
          setUser(null);
          return 'anonymous';
        }
        return prev;
      });
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const res = await api.auth.login(username, password);
    if (!mounted.current) return;
    setUser(res.user);
    setExpired(false);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.auth.logout();
    } catch (err) {
      // Even if the server logout call fails (e.g. already-expired session),
      // drop local auth state — never leave the user stuck "logged in".
      if (!(err instanceof ApiError)) throw err;
    } finally {
      if (mounted.current) {
        setUser(null);
        setExpired(false);
        setStatus('anonymous');
      }
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, login, logout, expired }),
    [status, user, login, logout, expired]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
