import { useState, type FormEvent } from 'react';
import type { SessionDto } from '../../shared/types.js';
import { InlineError } from '../components/ui';
import { api, errorText } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useSession } from '../lib/session';

export function LoginPage() {
  const { t } = useI18n();
  const { apply, meta } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      apply(await api<SessionDto>('POST', '/api/auth/login', { username, password }, { quiet401: true }));
    } catch (err) {
      setError(errorText(t, err));
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth__card">
        <p className="eyebrow">{meta?.siteTitle ?? t('app.title')}</p>
        <h1>{t('login.title')}</h1>
        <p className="muted">{t('login.intro')}</p>
        <form onSubmit={submit} className="form" noValidate>
          <div className="field">
            <label className="field__label" htmlFor="login-username">
              {t('login.username')}
            </label>
            <input
              id="login-username"
              className="input"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="login-password">
              {t('login.password')}
            </label>
            <input
              id="login-password"
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <InlineError message={error} />
          <button className="btn btn--primary btn--block" type="submit" disabled={busy || !username || !password}>
            {busy ? t('common.loading') : t('login.submit')}
          </button>
        </form>
        <p className="muted small">{t('login.noAccount')}</p>
        <p className="muted small">{t('login.forgot')}</p>
      </div>
    </div>
  );
}
