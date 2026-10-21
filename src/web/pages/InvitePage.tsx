import { useEffect, useState, type FormEvent } from 'react';
import type { InviteInspectDto, SessionDto } from '../../shared/types.js';
import { Field, InlineError, Spinner, StateMessage } from '../components/ui';
import { api, errorText } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { navigate } from '../lib/router';
import { useSession } from '../lib/session';
import { suggestUsername } from '../lib/util';

// The token arrives in the URL fragment (#token=...), which browsers never
// send to the server. It is read once, kept in memory and removed from the
// address bar (and so from the browser history).
let token: string | null = null;
function takeToken(): string | null {
  const m = /(?:^#|&)token=([A-Za-z0-9_-]{20,100})/.exec(window.location.hash);
  if (m) token = m[1]!;
  if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
  return token;
}

export function InvitePage() {
  const { t } = useI18n();
  const { apply } = useSession();
  const [linkToken] = useState(takeToken);
  const [info, setInfo] = useState<InviteInspectDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!linkToken) return;
    api<InviteInspectDto>('POST', '/api/invites/inspect', { token: linkToken }, { quiet401: true })
      .then((r) => {
        setInfo(r);
        if (r.needsUsername && r.name) setUsername(suggestUsername(r.name));
      })
      .catch((err) => setLoadError(errorText(t, err)));
  }, [linkToken, t]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== repeat) {
      setError(t('profile.passwordMismatch'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const s = await api<SessionDto>(
        'POST',
        '/api/invites/accept',
        { token: linkToken, password, ...(info?.needsUsername ? { username } : {}), ...(info?.needsDisplayName ? { displayName } : {}) },
        { quiet401: true },
      );
      apply(s);
      navigate(s.user?.employeeId != null ? '/me' : '/', { replace: true });
    } catch (err) {
      setError(errorText(t, err));
      setBusy(false);
    }
  };

  const title = info?.kind === 'reset' ? t('invite.titleReset') : info?.kind === 'setup' ? t('invite.titleSetup') : t('invite.titleInvite');
  const toLogin = (
    <button type="button" className="btn btn--secondary" onClick={() => navigate('/', { replace: true })}>
      {t('invite.toLogin')}
    </button>
  );

  return (
    <div className="auth">
      <div className="auth__card">
        <h1>{title}</h1>
        {!linkToken && <StateMessage tone="error" title={t('invite.noToken')} action={toLogin} />}
        {linkToken && !info && !loadError && <Spinner label={t('invite.checking')} />}
        {loadError && <StateMessage tone="error" title={loadError} action={toLogin} />}
        {info && info.status !== 'valid' && <StateMessage tone="error" title={t(`invite.${info.status}`)} text={t('invite.askNew')} action={toLogin} />}
        {info && info.status === 'valid' && (
          <form className="form" onSubmit={submit} noValidate>
            {info.name && <p>{t('invite.for', { name: info.name })}</p>}
            {info.username && <p className="muted">{t('invite.forUsername', { username: info.username })}</p>}
            {info.needsDisplayName && (
              <Field label={t('invite.displayName')}>
                {(id) => <input id={id} className="input" autoComplete="name" maxLength={80} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />}
              </Field>
            )}
            {info.needsUsername ? (
              <Field label={t('invite.username')} hint={t('invite.usernameHint')}>
                {(id, d) => (
                  <input
                    id={id}
                    aria-describedby={d}
                    className="input"
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    maxLength={40}
                    value={username}
                    onChange={(e) => setUsername(e.target.value.toLowerCase())}
                  />
                )}
              </Field>
            ) : (
              <input type="text" autoComplete="username" value={info.username ?? ''} hidden readOnly />
            )}
            <Field label={t('invite.password')} hint={t('profile.passwordHint')}>
              {(id, d) => <input id={id} aria-describedby={d} className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
            </Field>
            <Field label={t('invite.repeat')}>
              {(id) => <input id={id} className="input" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />}
            </Field>
            <InlineError message={error} />
            <button type="submit" className="btn btn--primary btn--block" disabled={busy || !password || (info.needsUsername && !username)}>
              {busy ? t('common.saving') : info.kind === 'reset' || (!info.needsUsername && info.kind === 'invite') ? t('invite.submitReset') : info.kind === 'setup' ? t('invite.submitSetup') : t('invite.submitInvite')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
