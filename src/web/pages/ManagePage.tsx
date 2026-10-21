import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { AVAILABILITY, type Availability } from '../../shared/constants.js';
import type { CompanyDto, DirectoryDto, EmployeeDto, InviteDto, InviteLinkDto, ManagedEmployeeDto, TeamDto } from '../../shared/types.js';
import { AvailabilityBadge, Avatar, Completeness, CopyLink, Dialog, Field, InlineError, LanguagePicker, Spinner, StateMessage, useUi } from '../components/ui';
import { api, errorText, fieldErrors } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Link, setQuery, useLocation } from '../lib/router';
import { useSession } from '../lib/session';
import type { StringKey } from '../lib/strings';
import { fold, useLoad } from '../lib/util';

interface EmployeeForm {
  firstName: string;
  lastName: string;
  companyId: number | null;
  teamId: number | null;
  officialTitle: string;
  algoritmiAvailability: Availability | null;
  profession: string;
  currentWork: string;
  languages: string[];
  workEmail: string;
  phone: string;
}

const EMPTY: EmployeeForm = {
  firstName: '',
  lastName: '',
  companyId: null,
  teamId: null,
  officialTitle: '',
  algoritmiAvailability: null,
  profession: '',
  currentWork: '',
  languages: [],
  workEmail: '',
  phone: '',
};

function fromEmployee(e: EmployeeDto): EmployeeForm {
  return {
    firstName: e.firstName,
    lastName: e.lastName,
    companyId: e.companyId,
    teamId: e.teamId,
    officialTitle: e.officialTitle,
    algoritmiAvailability: e.algoritmiAvailability,
    profession: e.profession,
    currentWork: e.currentWork,
    languages: e.languages,
    workEmail: e.workEmail ?? '',
    phone: e.phone ?? '',
  };
}

function EmployeeEditor({
  employee,
  companies,
  teams,
  onDone,
  onPhotoRemoved,
}: {
  employee: EmployeeDto | null;
  companies: CompanyDto[];
  teams: TeamDto[];
  onDone: (saved: EmployeeDto) => void;
  onPhotoRemoved: () => void;
}) {
  const { t } = useI18n();
  const { confirm, toast } = useUi();
  const [photoUrl, setPhotoUrl] = useState(employee?.photoUrl ?? null);
  const [form, setForm] = useState<EmployeeForm>(employee ? fromEmployee(employee) : EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof EmployeeForm>(k: K, v: EmployeeForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const companyTeams = teams.filter((tm) => tm.companyId === form.companyId && (tm.active || tm.id === form.teamId));
  const selectableCompanies = companies.filter((c) => c.active || c.id === form.companyId);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setError(null);
    try {
      let body: Record<string, unknown> = { ...form };
      if (employee) {
        const before = fromEmployee(employee) as unknown as Record<string, unknown>;
        body = Object.fromEntries(Object.entries(form).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(before[k])));
      }
      const saved = employee
        ? await api<EmployeeDto>('PATCH', `/api/employees/${employee.id}`, body)
        : await api<EmployeeDto>('POST', '/api/employees', body);
      onDone(saved);
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorText(t, err, (f) => t(`field.${f}` as StringKey)));
    } finally {
      setBusy(false);
    }
  };

  // Moderation only: a new photo is always taken by the person with the camera.
  const removePhoto = async () => {
    if (!employee) return;
    if (!(await confirm(t('manage.removePhotoConfirm', { name: `${employee.firstName} ${employee.lastName}` }), { danger: true, confirmLabel: t('manage.removePhoto') }))) return;
    try {
      await api('DELETE', `/api/employees/${employee.id}/photo`);
      setPhotoUrl(null);
      toast(t('manage.photoRemoved'));
      onPhotoRemoved();
    } catch (err) {
      toast(errorText(t, err), 'error');
    }
  };

  return (
    <form className="form" onSubmit={submit} noValidate>
      {employee && (
        <fieldset className="form-group">
          <legend>{t('manage.photo')}</legend>
          <div className="photo-row">
            <Avatar first={employee.firstName} last={employee.lastName} photoUrl={photoUrl} />
            <div>
              <p className="muted small">{t('manage.photoHint')}</p>
              {photoUrl ? (
                <button type="button" className="btn btn--ghost btn--small btn--danger-text" onClick={() => void removePhoto()}>
                  {t('manage.removePhoto')}
                </button>
              ) : (
                <p className="muted small">{t('manage.noPhotoYet')}</p>
              )}
            </div>
          </div>
        </fieldset>
      )}
      <fieldset className="form-group">
        <legend>{t('manage.identity')}</legend>
        <div className="form-row">
          <Field label={t('field.firstName')} error={errors.firstName}>
            {(id) => <input id={id} className="input" required maxLength={80} value={form.firstName} onChange={(e) => set('firstName', e.target.value)} />}
          </Field>
          <Field label={t('field.lastName')} error={errors.lastName}>
            {(id) => <input id={id} className="input" required maxLength={80} value={form.lastName} onChange={(e) => set('lastName', e.target.value)} />}
          </Field>
        </div>
      </fieldset>
      <fieldset className="form-group">
        <legend>{t('manage.official')}</legend>
        <div className="form-row">
          <Field label={t('field.company')} error={errors.companyId}>
            {(id) => (
              <select
                id={id}
                className="select"
                value={form.companyId ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, companyId: e.target.value ? Number(e.target.value) : null, teamId: null }))}
              >
                <option value="">{t('field.noCompany')}</option>
                {selectableCompanies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('field.team')} error={errors.teamId} hint={form.companyId == null ? t('field.chooseCompanyFirst') : undefined}>
            {(id, d) => (
              <select id={id} aria-describedby={d} className="select" value={form.teamId ?? ''} disabled={form.companyId == null} onChange={(e) => set('teamId', e.target.value ? Number(e.target.value) : null)}>
                <option value="">{t('field.noTeam')}</option>
                {companyTeams.map((tm) => (
                  <option key={tm.id} value={tm.id}>
                    {tm.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <Field label={t('field.officialTitle')} error={errors.officialTitle}>
          {(id) => <input id={id} className="input" maxLength={120} value={form.officialTitle} onChange={(e) => set('officialTitle', e.target.value)} />}
        </Field>
        <fieldset className="field">
          <legend className="field__label">{t('field.availability')}</legend>
          <div className="segmented">
            {[...AVAILABILITY, null].map((a) => (
              <label key={a ?? 'unset'} className={`segmented__item${form.algoritmiAvailability === a ? ' is-on' : ''}`}>
                <input type="radio" name="availability" checked={form.algoritmiAvailability === a} onChange={() => set('algoritmiAvailability', a)} />
                <span>{t(a ? `avail.${a}` : 'avail.unset')}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </fieldset>
      <fieldset className="form-group">
        <legend>{t('manage.personal')}</legend>
        <Field label={t('field.profession')} error={errors.profession}>
          {(id) => <input id={id} className="input" maxLength={120} value={form.profession} onChange={(e) => set('profession', e.target.value)} />}
        </Field>
        <Field label={t('field.currentWork')} error={errors.currentWork}>
          {(id) => <textarea id={id} className="input textarea" rows={3} maxLength={1000} value={form.currentWork} onChange={(e) => set('currentWork', e.target.value)} />}
        </Field>
        <LanguagePicker legend={t('field.languages')} value={form.languages} onChange={(v) => set('languages', v)} />
        <div className="form-row">
          <Field label={t('field.workEmail')} error={errors.workEmail} optional>
            {(id) => <input id={id} className="input" type="email" maxLength={254} value={form.workEmail} onChange={(e) => set('workEmail', e.target.value)} />}
          </Field>
          <Field label={t('field.phone')} error={errors.phone} optional>
            {(id) => <input id={id} className="input" type="tel" maxLength={40} value={form.phone} onChange={(e) => set('phone', e.target.value)} />}
          </Field>
        </div>
      </fieldset>
      <InlineError message={error} />
      <div className="actions">
        <button type="submit" className="btn btn--primary" disabled={busy || !form.firstName.trim() || !form.lastName.trim()}>
          {busy ? t('common.saving') : t('common.saveChanges')}
        </button>
      </div>
    </form>
  );
}

export function InviteLinkDialog({ result, title, text, onClose }: { result: InviteLinkDto | null; title: string; text: string; onClose: () => void }) {
  const { t, formatDate } = useI18n();
  return (
    <Dialog open={!!result} onClose={onClose} title={title}>
      {result && (
        <>
          <p>{text.replace('{date}', formatDate(result.expiresAt, true))}</p>
          <CopyLink link={result.link} />
          <p className="muted small">{t('manage.inviteReplaces')}</p>
          <div className="actions">
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              {t('common.close')}
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}

export function ManagePage() {
  const { t, formatDate } = useI18n();
  const { user } = useSession();
  const { toast, confirm } = useUi();
  const { query } = useLocation();
  const isAdmin = user?.role === 'admin';
  const list = useLoad(() => api<ManagedEmployeeDto[]>('GET', '/api/manage/employees'), []);
  const lookups = useLoad(() => api<DirectoryDto>('GET', '/api/directory'), []);
  const invites = useLoad(() => api<InviteDto[]>('GET', '/api/invites'), []);

  const [search, setSearch] = useState('');
  const [incomplete, setIncomplete] = useState(false);
  const [noPhoto, setNoPhoto] = useState(false);
  const [status, setStatus] = useState<'active' | 'inactive' | 'all'>('active');
  const [editing, setEditing] = useState<EmployeeDto | 'new' | null>(null);
  const [link, setLink] = useState<{ result: InviteLinkDto; name: string; existing: boolean } | null>(null);

  // /manage?edit=<id> (link from the person page) opens the editor directly.
  const editParam = query.get('edit');
  useEffect(() => {
    if (!editParam || !list.data) return;
    const e = list.data.find((x) => String(x.id) === editParam);
    if (e) setEditing(e);
    setQuery({ edit: null });
  }, [editParam, list.data]);

  const rows = useMemo(() => {
    const words = fold(search).split(/\s+/).filter(Boolean);
    return (list.data ?? []).filter((e) => {
      if (status !== 'all' && e.status !== status) return false;
      if (incomplete && e.completeness >= 100) return false;
      if (noPhoto && e.photoUrl) return false;
      const hay = fold(`${e.firstName} ${e.lastName} ${e.officialTitle} ${e.companyName ?? ''} ${e.teamName ?? ''}`);
      return words.every((w) => hay.includes(w));
    });
  }, [list.data, search, status, incomplete, noPhoto]);

  const active = (list.data ?? []).filter((e) => e.status === 'active');
  const refresh = () => {
    void list.reload();
    void invites.reload();
  };

  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast(done);
      refresh();
    } catch (err) {
      toast(errorText(t, err), 'error');
    }
  };

  const createInvite = async (e: ManagedEmployeeDto) => {
    try {
      const result = await api<InviteLinkDto>('POST', `/api/employees/${e.id}/invite`, {});
      setLink({ result, name: `${e.firstName} ${e.lastName}`, existing: e.account === 'active' });
      refresh();
    } catch (err) {
      toast(errorText(t, err), 'error');
    }
  };

  const revoke = async (inviteId: number) => {
    if (await confirm(t('manage.revokeConfirm'), { danger: true, confirmLabel: t('manage.revoke') })) {
      await act(() => api('DELETE', `/api/invites/${inviteId}`), t('manage.revoked'));
    }
  };

  const accountText = (e: ManagedEmployeeDto) =>
    e.account === 'invited' && e.invite ? t('manage.account.invited', { date: formatDate(e.invite.expiresAt, true) }) : t(`manage.account.${e.account}`);

  return (
    <div className="page page--wide">
      <div className="page__head page__head--row">
        <h1>{t('manage.title')}</h1>
        <button type="button" className="btn btn--primary" onClick={() => setEditing('new')}>
          {t('manage.add')}
        </button>
      </div>

      {list.data && (
        <p className="summary">
          {t('manage.summary', {
            total: active.length,
            noPhoto: active.filter((e) => !e.photoUrl).length,
            incomplete: active.filter((e) => e.completeness < 100).length,
          })}
        </p>
      )}

      <div className="toolbar toolbar--manage">
        <div className="search">
          <label htmlFor="manage-search" className="visually-hidden">
            {t('manage.search')}
          </label>
          <input id="manage-search" className="input" type="search" placeholder={t('manage.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <label className="check">
          <input type="checkbox" checked={incomplete} onChange={(e) => setIncomplete(e.target.checked)} /> {t('manage.onlyIncomplete')}
        </label>
        <label className="check">
          <input type="checkbox" checked={noPhoto} onChange={(e) => setNoPhoto(e.target.checked)} /> {t('manage.onlyNoPhoto')}
        </label>
        <label className="filter">
          <span className="filter__label">{t('manage.status')}</span>
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="active">{t('manage.statusActive')}</option>
            <option value="inactive">{t('manage.statusInactive')}</option>
            <option value="all">{t('manage.statusAll')}</option>
          </select>
        </label>
      </div>

      {list.loading && !list.data && <Spinner />}
      {list.error != null && <StateMessage tone="error" title={errorText(t, list.error)} action={<button type="button" className="btn btn--primary" onClick={refresh}>{t('common.retry')}</button>} />}
      {list.data && rows.length === 0 && <StateMessage title={t('manage.empty')} />}

      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="table table--cards">
            <thead>
              <tr>
                <th scope="col">{t('manage.colName')}</th>
                <th scope="col">{t('manage.colCompanyTeam')}</th>
                <th scope="col">{t('manage.colAlgoritmi')}</th>
                <th scope="col">{t('manage.colProfile')}</th>
                <th scope="col">{t('manage.colAccount')}</th>
                <th scope="col">
                  <span className="visually-hidden">{t('manage.colActions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className={e.status === 'inactive' ? 'is-inactive' : undefined}>
                  <td data-label={t('manage.colName')}>
                    <div className="who">
                      <Avatar first={e.firstName} last={e.lastName} photoUrl={e.photoUrl} size="sm" />
                      <div>
                        <Link to={`/people/${e.id}`} className="who__name">
                          {e.firstName} {e.lastName}
                        </Link>
                        <div className="muted small">{e.officialTitle || t('common.none')}</div>
                        {e.status === 'inactive' && <span className="tag">{t('manage.inactiveTag')}</span>}
                        {e.isDemo && <span className="tag tag--demo">{t('common.demo')}</span>}
                      </div>
                    </div>
                  </td>
                  <td data-label={t('manage.colCompanyTeam')}>
                    {e.companyName ?? t('common.none')}
                    <div className="muted small">{e.teamName ?? t('common.none')}</div>
                  </td>
                  <td data-label={t('manage.colAlgoritmi')}>
                    <AvailabilityBadge value={e.algoritmiAvailability} />
                  </td>
                  <td data-label={t('manage.colProfile')}>
                    <div className="profile-cell">
                      <Completeness percent={e.completeness} label={t('profile.completeness', { percent: e.completeness })} />
                      <span className="small">{e.completeness}%</span>
                      {!e.photoUrl && <span className="tag tag--warn">{t('manage.noPhoto')}</span>}
                    </div>
                  </td>
                  <td data-label={t('manage.colAccount')}>
                    <span className={`account account--${e.account}`}>{accountText(e)}</span>
                  </td>
                  <td className="row-actions">
                    <button type="button" className="btn btn--secondary btn--small" onClick={() => setEditing(e)}>
                      {t('common.edit')}
                    </button>
                    {e.status === 'active' && e.account !== 'disabled' && (
                      <button type="button" className="btn btn--ghost btn--small" onClick={() => void createInvite(e)}>
                        {e.account === 'none' ? t('manage.invite') : t('manage.reinvite')}
                      </button>
                    )}
                    {e.invite && (
                      <button type="button" className="btn btn--ghost btn--small" onClick={() => void revoke(e.invite!.id)}>
                        {t('manage.revoke')}
                      </button>
                    )}
                    {isAdmin && e.status === 'active' && e.id !== user?.employeeId && (
                      <button
                        type="button"
                        className="btn btn--ghost btn--small btn--danger-text"
                        onClick={async () => {
                          if (await confirm(t('manage.deactivateConfirm', { name: `${e.firstName} ${e.lastName}` }), { danger: true, confirmLabel: t('manage.deactivate') })) {
                            await act(() => api('POST', `/api/employees/${e.id}/deactivate`, {}), t('manage.deactivated'));
                          }
                        }}
                      >
                        {t('manage.deactivate')}
                      </button>
                    )}
                    {isAdmin && e.status === 'inactive' && (
                      <>
                        <button type="button" className="btn btn--ghost btn--small" onClick={() => void act(() => api('POST', `/api/employees/${e.id}/activate`, {}), t('manage.activated'))}>
                          {t('manage.activate')}
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost btn--small btn--danger-text"
                          onClick={async () => {
                            if (await confirm(t('manage.deleteConfirm', { name: `${e.firstName} ${e.lastName}` }), { danger: true, confirmLabel: t('manage.deleteForever') })) {
                              await act(() => api('DELETE', `/api/employees/${e.id}`), t('manage.deleted'));
                            }
                          }}
                        >
                          {t('manage.deleteForever')}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className="panel" aria-labelledby="invites-title">
        <h2 id="invites-title" className="section-title">
          {t('manage.invitesTitle')}
        </h2>
        {invites.data && invites.data.length === 0 && <p className="muted">{t('manage.noInvites')}</p>}
        {invites.data && invites.data.length > 0 && (
          <ul className="plain-list">
            {invites.data.map((i) => (
              <li key={i.id} className="plain-list__row">
                <span>
                  <strong>{i.employeeName ?? i.displayName ?? t('common.none')}</strong> · {t(`role.${i.role}`)} · {t('manage.expires', { date: formatDate(i.expiresAt, true) })}
                </span>
                <button type="button" className="btn btn--ghost btn--small" onClick={() => void revoke(i.id)}>
                  {t('manage.revoke')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? t('manage.addTitle') : t('manage.editTitle')} wide>
        {editing !== null && lookups.data && (
          <EmployeeEditor
            employee={editing === 'new' ? null : editing}
            companies={lookups.data.companies}
            teams={lookups.data.teams}
            onDone={() => {
              toast(editing === 'new' ? t('manage.created') : t('manage.updated'));
              setEditing(null);
              refresh();
            }}
            onPhotoRemoved={refresh}
          />
        )}
      </Dialog>

      <InviteLinkDialog
        result={link?.result ?? null}
        title={t('manage.inviteTitle', { name: link?.name ?? '' })}
        text={`${t('manage.inviteText')}${link?.existing ? ` ${t('manage.inviteExisting')}` : ''}`}
        onClose={() => setLink(null)}
      />
    </div>
  );
}
