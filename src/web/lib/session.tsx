import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { MetaDto, SessionDto, SessionUserDto } from '../../shared/types.js';
import { api, setCsrfToken, setUnauthorizedHandler } from './api';

interface SessionCtx {
  status: 'loading' | 'ready' | 'error';
  user: SessionUserDto | null;
  meta: MetaDto | null;
  version: string | null;
  apply: (s: SessionDto) => void;
  reload: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionCtx['status']>('loading');
  const [user, setUser] = useState<SessionUserDto | null>(null);
  const [meta, setMeta] = useState<MetaDto | null>(null);
  const [version, setVersion] = useState<string | null>(null);

  const apply = useCallback((s: SessionDto) => {
    setCsrfToken(s.csrfToken);
    setUser(s.user);
    setVersion(s.version ?? null);
  }, []);

  const reload = useCallback(async () => {
    try {
      const [m, s] = await Promise.all([api<MetaDto>('GET', '/api/meta'), api<SessionDto>('GET', '/api/auth/session', undefined, { quiet401: true })]);
      setMeta(m);
      apply(s);
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  }, [apply]);

  const signOut = useCallback(async () => {
    try {
      await api('POST', '/api/auth/logout', {}, { quiet401: true });
    } finally {
      setCsrfToken('');
      setUser(null);
    }
  }, []);

  useEffect(() => {
    // A 401 on any call means the session ended (expired, revoked, account disabled).
    setUnauthorizedHandler(() => {
      setCsrfToken('');
      setUser(null);
    });
    void reload();
  }, [reload]);

  return <Ctx.Provider value={{ status, user, meta, version, apply, reload, signOut }}>{children}</Ctx.Provider>;
}

export function useSession(): SessionCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('SessionProvider missing');
  return v;
}
