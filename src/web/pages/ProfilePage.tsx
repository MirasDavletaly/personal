import { useEffect, useState, type FormEvent } from 'react';
import { SELF_FIELDS } from '../../shared/constants.js';
import type { EmployeeDto, MeDto } from '../../shared/types.js';
import { SelfieDialog } from '../components/Camera';
import { AvailabilityBadge, Avatar, Completeness, Field, Icon, InlineError, LanguagePicker, Spinner, StateMessage, useUi } from '../components/ui';
import { api, errorText, fieldErrors } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useSession } from '../lib/session';
import type { StringKey } from '../lib/strings';
import { useLoad } from '../lib/util';

const PROFESSIONS = ['Architect', 'Engineer', 'Notary', 'CFO', 'Accountant', 'Lawyer', 'Project manager', 'Designer', 'Economist', 'Analyst'];

interface FormState {
  profession: string;
  currentWork: string;
  languages: string[];
  workEmail: string;
  phone: string;
}

function toForm(e: EmployeeDto): FormState {
  return { profession: e.profession, currentWork: e.currentWork, languages: e.languages, workEmail: e.workEmail ?? '', phone: e.phone ?? '' };
}

function PasswordForm() {
  const { t } = useI18n();
  const { toast } = useUi();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== repeat) {
      setError(t('profile.passwordMismatch'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/auth/password', { currentPassword: current, newPassword: next });
      setCurrent('');
      setNext('');
      setRepeat('');
      toast(t('profile.passwordChanged'));
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="panel panel--plain">
      <summary className="panel__summary">{t('profile.changePassword')}</summary>
      <form className="form" onSubmit={submit}>
        <input type="text" autoComplete="username" hidden readOnly />
        <Field label={t('profile.currentPassword')}>
          {(id) => <input id={id} className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />}
        </Field>
        <Field label={t('profile.newPassword')} hint={t('profile.passwordHint')}>
          {(id, d) => <input id={id} aria-describedby={d} className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />}
        </Field>
        <Field label={t('profile.repeatPassword')}>
          {(id) => <input id={id} className="input" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />}
        </Field>
        <InlineError message={error} />
        <button type="submit" className="btn btn--secondary" disabled={busy || !current || !next}>
          {busy ? t('common.saving') : t('profile.changePassword')}
        </button>
      </form>
    </details>
  );
}

export function ProfilePage() {
  const { t, languageName, formatDate } = useI18n();
  const { meta } = useSession();
  const { toast, confirm } = useUi();
  const { data, setData, error, loading, reload } = useLoad(() => api<MeDto>('GET', '/api/me'), []);
  const [form, setForm] = useState<FormState | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [camera, setCamera] = useState(false);

  useEffect(() => {
    if (data?.employee) setForm(toForm(data.employee));
  }, [data]);

  if (loading && !data) return <div className="page"><Spinner /></div>;
  if (error || !data) {
    return (
      <div className="page">
        <h1>{t('profile.title')}</h1>
        <StateMessage tone="error" title={errorText(t, error)} action={<button className="btn btn--primary" type="button" onClick={() => void reload()}>{t('common.retry')}</button>} />
      </div>
    );
  }

  const e = data.employee;
  const setEmployee = (emp: EmployeeDto) => setData({ ...data, employee: emp });

  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!e || !form) return;
    const before = toForm(e);
    const changes: Record<string, unknown> = {};
    for (const f of SELF_FIELDS) {
      if (JSON.stringify(form[f]) !== JSON.stringify(before[f])) changes[f] = form[f];
    }
    if (!Object.keys(changes).length) {
      toast(t('profile.nothingChanged'));
      return;
    }
    setSaving(true);
    setErrors({});
    setFormError(null);
    try {
      const updated = await api<EmployeeDto>('PATCH', '/api/me/profile', changes);
      setEmployee(updated);
      setSavedAt(Date.now());
      toast(t('profile.saved'));
    } catch (err) {
      setErrors(fieldErrors(err));
      setFormError(errorText(t, err, (f) => t(`field.${f}` as StringKey)));
    } finally {
      setSaving(false);
    }
  };

  const removePhoto = async () => {
    if (!e || !(await confirm(t('profile.removePhotoConfirm'), { danger: true, confirmLabel: t('profile.removePhoto') }))) return;
    try {
      setEmployee(await api<EmployeeDto>('DELETE', `/api/employees/${e.id}/photo`));
      toast(t('profile.photoRemoved'));
    } catch (err) {
      toast(errorText(t, err), 'error');
    }
  };

  const missingText = e?.missing.map((m) => t(`item.${m}` as StringKey)).join(', ');

  return (
    <div className="page page--narrow">
      <div className="page__head">
        <h1>{t('profile.title')}</h1>
      </div>

      {!e && <StateMessage title={t('profile.noEmployee')} />}

      {e && form && (
        <>
          <section className="panel profile-head" aria-label={t('profile.photo')}>
            <Avatar first={e.firstName} last={e.lastName} photoUrl={e.photoUrl} size="lg" />
            <div className="profile-head__info">
              <p className="profile-head__name">
                {e.firstName} {e.lastName}
              </p>
              <p className="muted">{t('profile.photoHint')}</p>
              <div className="actions">
                <button type="button" className="btn btn--primary" onClick={() => setCamera(true)}>
                  <Icon name="camera" /> {e.photoUrl ? t('profile.retakeSelfie') : t('profile.takeSelfie')}
                </button>
                {e.photoUrl && (
                  <button type="button" className="btn btn--ghost" onClick={() => void removePhoto()}>
                    {t('profile.removePhoto')}
                  </button>
                )}
              </div>
            </div>
            <div className="profile-head__meter">
              <p className="meter__label">{t('profile.completeness', { percent: e.completeness })}</p>
              <Completeness percent={e.completeness} label={t('profile.completeness', { percent: e.completeness })} />
              <p className="muted small">{e.missing.length ? t('profile.missing', { items: missingText ?? '' }) : t('profile.complete')}</p>
              <p className="muted small">{t('person.updated', { date: formatDate(e.updatedAt) })}</p>
            </div>
          </section>

          <section className="panel panel--note" aria-labelledby="privacy-title">
            <h2 id="privacy-title" className="section-title">
              {t('profile.privacyTitle')}
            </h2>
            <p>{t('profile.privacyText')}</p>
            {meta?.privacyContact && <p className="small">{t('profile.privacyContact', { contact: meta.privacyContact })}</p>}
          </section>

          <section className="panel" aria-labelledby="official-title">
            <h2 id="official-title" className="section-title">
              <Icon name="lock" /> {t('profile.official')}
            </h2>
            <p className="muted small">{t('profile.officialNote')}</p>
            <dl className="facts facts--compact">
              <div className="facts__row">
                <dt>{t('field.company')}</dt>
                <dd>{e.companyName ?? <span className="muted">{t('common.notProvided')}</span>}</dd>
              </div>
              <div className="facts__row">
                <dt>{t('field.team')}</dt>
                <dd>{e.teamName ?? <span className="muted">{t('common.notProvided')}</span>}</dd>
              </div>
              <div className="facts__row">
                <dt>{t('field.officialTitle')}</dt>
                <dd>{e.officialTitle || <span className="muted">{t('common.notProvided')}</span>}</dd>
              </div>
              <div className="facts__row">
                <dt>{t('field.availability')}</dt>
                <dd>
                  <AvailabilityBadge value={e.algoritmiAvailability} />
                </dd>
              </div>
            </dl>
          </section>

          <form className="panel form" onSubmit={save} noValidate aria-labelledby="about-title">
            <h2 id="about-title" className="section-title">
              {t('profile.about')}
            </h2>
            <Field label={t('field.profession')} hint={t('profile.professionHint')} error={errors.profession}>
              {(id, d) => (
                <>
                  <input id={id} aria-describedby={d} className="input" list="professions" maxLength={120} value={form.profession} onChange={(ev) => setForm({ ...form, profession: ev.target.value })} />
                  <datalist id="professions">
                    {PROFESSIONS.map((p) => (
                      <option key={p} value={p} />
                    ))}
                  </datalist>
                </>
              )}
            </Field>
            <Field label={t('field.currentWork')} hint={t('profile.currentWorkHint')} error={errors.currentWork}>
              {(id, d) => <textarea id={id} aria-describedby={d} className="input textarea" rows={4} maxLength={1000} value={form.currentWork} onChange={(ev) => setForm({ ...form, currentWork: ev.target.value })} />}
            </Field>
            <LanguagePicker legend={t('field.languages')} value={form.languages} onChange={(languages) => setForm({ ...form, languages })} />
            {form.languages.length > 0 && <p className="muted small">{form.languages.map(languageName).join(', ')}</p>}
            <Field label={t('field.workEmail')} hint={t('profile.contactsHint')} error={errors.workEmail} optional>
              {(id, d) => <input id={id} aria-describedby={d} className="input" type="email" inputMode="email" autoComplete="email" maxLength={254} value={form.workEmail} onChange={(ev) => setForm({ ...form, workEmail: ev.target.value })} />}
            </Field>
            <Field label={t('field.phone')} hint={t('profile.contactsHint')} error={errors.phone} optional>
              {(id, d) => <input id={id} aria-describedby={d} className="input" type="tel" inputMode="tel" autoComplete="tel" maxLength={40} value={form.phone} onChange={(ev) => setForm({ ...form, phone: ev.target.value })} />}
            </Field>
            <InlineError message={formError} />
            <div className="actions">
              <button type="submit" className="btn btn--primary" disabled={saving}>
                {saving ? t('common.saving') : t('common.saveChanges')}
              </button>
              {savedAt && !saving && (
                <span className="saved-note" role="status">
                  <Icon name="check" /> {t('profile.saved')}
                </span>
              )}
            </div>
          </form>

          <SelfieDialog
            open={camera}
            onClose={() => setCamera(false)}
            onSaved={(emp) => {
              setEmployee(emp);
              setCamera(false);
              toast(t('profile.photoSaved'));
            }}
          />
        </>
      )}

      <section className="panel" aria-labelledby="account-title">
        <h2 id="account-title" className="section-title">
          {t('profile.account')}
        </h2>
        <p className="muted">
          {t('profile.username', { username: data.user.username })} · {t(`role.${data.user.role}`)}
        </p>
        <PasswordForm />
      </section>
    </div>
  );
}
