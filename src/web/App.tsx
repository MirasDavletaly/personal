import { useCallback } from 'react';
import type { Locale } from '../shared/constants.js';
import { Layout } from './components/Layout';
import { Spinner, StateMessage, UiProvider } from './components/ui';
import { api } from './lib/api';
import { I18nProvider, storedLocale, useI18n } from './lib/i18n';
import { matchPath, useLocation } from './lib/router';
import { SessionProvider, useSession } from './lib/session';
import { AdminPage } from './pages/AdminPage';
import { DirectoryPage } from './pages/DirectoryPage';
import { InvitePage } from './pages/InvitePage';
import { LoginPage } from './pages/LoginPage';
import { ManagePage } from './pages/ManagePage';
import { PersonPage } from './pages/PersonPage';
import { ProfilePage } from './pages/ProfilePage';

function Routes() {
  const { t } = useI18n();
  const { status, user, reload } = useSession();
  const { path } = useLocation();

  if (path === '/invite' || path === '/setup') return <InvitePage />;
  if (status === 'loading') return <Spinner />;
  if (status === 'error') {
    return (
      <StateMessage
        tone="error"
        title={t('err.network')}
        action={
          <button type="button" className="btn btn--primary" onClick={() => void reload()}>
            {t('common.retry')}
          </button>
        }
      />
    );
  }
  if (!user) return <LoginPage />;

  const person = matchPath('/people/:id', path);
  if (person) return <PersonPage id={person.id!} />;
  if (path === '/me') return <ProfilePage />;
  if (path === '/manage' && (user.role === 'admin' || user.role === 'coordinator')) return <ManagePage />;
  if ((path === '/admin' || path.startsWith('/admin/')) && user.role === 'admin') return <AdminPage />;
  return <DirectoryPage />;
}

/** Picks the language: saved choice on this device, then the account, then the site default (English). */
function LocaleBridge() {
  const { user, meta } = useSession();
  const initial: Locale = storedLocale() ?? user?.locale ?? meta?.defaultLocale ?? 'en';
  const onChange = useCallback(
    (l: Locale) => {
      if (user) void api('PUT', '/api/auth/locale', { locale: l }).catch(() => undefined);
    },
    [user],
  );
  return (
    <I18nProvider key={`${user?.id ?? 'anon'}-${meta ? 1 : 0}`} initial={initial} onChange={onChange}>
      <UiProvider>
        <Layout>
          <Routes />
        </Layout>
      </UiProvider>
    </I18nProvider>
  );
}

export function App() {
  return (
    <SessionProvider>
      <LocaleBridge />
    </SessionProvider>
  );
}
