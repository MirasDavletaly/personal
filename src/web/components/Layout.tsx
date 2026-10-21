import { useEffect, useRef, type ReactNode } from 'react';
import { LOCALES } from '../../shared/constants.js';
import { useI18n } from '../lib/i18n';
import { Link, navigate, useLocation } from '../lib/router';
import { useSession } from '../lib/session';

export function LanguageSwitch() {
  const { locale, setLocale, t } = useI18n();
  return (
    <div className="lang" role="group" aria-label={t('nav.language')}>
      {LOCALES.map((l) => (
        <button key={l} type="button" className={`lang__btn${l === locale ? ' is-on' : ''}`} aria-pressed={l === locale} onClick={() => setLocale(l)} lang={l}>
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { user, meta, signOut, version } = useSession();
  const { path } = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const firstPath = useRef(path);

  // Move focus to the page heading after client-side navigation (screen
  // readers, keyboard). Not on the first load: Tab must reach the skip link.
  useEffect(() => {
    if (path === firstPath.current) return;
    firstPath.current = '';
    const h1 = mainRef.current?.querySelector('h1');
    if (h1) {
      h1.setAttribute('tabindex', '-1');
      h1.focus({ preventScroll: true });
    }
  }, [path]);

  const items = user
    ? [
        { to: '/', label: t('nav.directory'), active: path === '/' || path.startsWith('/people') },
        { to: '/me', label: t('nav.profile'), active: path === '/me' },
        ...(user.role === 'admin' || user.role === 'coordinator' ? [{ to: '/manage', label: t('nav.manage'), active: path.startsWith('/manage') }] : []),
        ...(user.role === 'admin' ? [{ to: '/admin', label: t('nav.admin'), active: path.startsWith('/admin') }] : []),
      ]
    : [];

  return (
    <>
      <a className="skip-link" href="#main">
        {t('app.skip')}
      </a>
      <header className="topbar">
        <div className="topbar__inner">
          <Link to="/" className="brand">
            <span className="brand__mark" aria-hidden="true">
              TK
            </span>
            <span className="brand__name">{meta?.siteTitle ?? t('app.title')}</span>
          </Link>
          <div className="topbar__tools">
            <LanguageSwitch />
            {user && (
              <button
                type="button"
                className="btn btn--ghost btn--small"
                onClick={async () => {
                  await signOut();
                  navigate('/');
                }}
              >
                {t('nav.signOut')}
              </button>
            )}
          </div>
        </div>
        {items.length > 0 && (
          <nav className="nav" aria-label={t('nav.main')}>
            <ul className="nav__list">
              {items.map((i) => (
                <li key={i.to}>
                  <Link to={i.to} className={`nav__link${i.active ? ' is-active' : ''}`} aria-current={i.active ? 'page' : undefined}>
                    {i.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </header>
      <main id="main" ref={mainRef} className="main">
        {children}
      </main>
      <footer className="footer">
        {user && <span>{t('nav.signedInAs', { name: user.displayName })}</span>}
        {version && <span>{t('app.version', { version })}</span>}
      </footer>
    </>
  );
}
