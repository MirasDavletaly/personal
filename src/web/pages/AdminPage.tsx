import { useEffect, useState, type FormEvent } from 'react';
import { LOCALES, ROLES, type Locale, type Role } from '../../shared/constants.js';
import type { AuditEntryDto, BackupFileDto, CompanyDto, DirectoryDto, InviteDto, InviteLinkDto, ManagedEmployeeDto, SettingsDto, TeamDto, UserDto } from '../../shared/types.js';
import { Dialog, Field, InlineError, Spinner, StateMessage, useUi } from '../components/ui';
import { api, errorText } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Link, matchPath, useLocation } from '../lib/router';
import { useSession } from '../lib/session';
import type { StringKey } from '../lib/strings';
import { useLoad } from '../lib/util';
import { InviteLinkDialog } from './ManagePage';

const TABS = ['users', 'structure', 'audit', 'backup', 'settings'] as const;
type Tab = (typeof TABS)[number];

// ------------------------------------------------------------------- users

function UsersTab() {
  const { t, formatDate } = useI18n();
  const { user: me } = useSession();
  const { toast, confirm } = useUi();
  const users = useLoad(() => api<UserDto[]>('GET', '/api/admin/users'), []);
  const employees = useLoad(() => api<ManagedEmployeeDto[]>('GET', '/api/manage/employees'), []);
  const invites = useLoad(() => api<InviteDto[]>('GET', '/api/invites'), []);
  const [link, setLink] = useState<{ result: InviteLinkDto; title: string; text: string } | null>(null);
  const [role, setRole] = useState<Role>('viewer');
  const [name, setName] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    void users.reload();
    void invites.reload();
    void employees.reload();
  };

  const patch = async (u: UserDto, body: Record<string, unknown>) => {
    try {
      await api('PATCH', `/api/admin/users/${u.id}`, body);
      toast(t('admin.users.updated'));
      refresh();
    } catch (err) {
      toast(errorText(t, err), 'error');
      refresh();
    }
  };

  const invite = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const body = { role, displayName: name || undefined, employeeId: employeeId ? Number(employeeId) : null };
      const result = await api<InviteLinkDto>('POST', '/api/admin/invites', body);
      const emp = employees.data?.find((x) => String(x.id) === employeeId);
      setLink({ result, title: t('admin.invite.linkTitle', { name: emp ? `${emp.firstName} ${emp.lastName}` : name }), text: t('manage.inviteText') });
      setName('');
      setEmployeeId('');
      refresh();
    } catch (err) {
      setError(errorText(t, err));
    }
  };

  const withoutAccount = (employees.data ?? []).filter((e) => e.status === 'active' && e.userId == null);

  return (
    <>
      {users.loading && !users.data && <Spinner />}
      {users.error != null && <StateMessage tone="error" title={errorText(t, users.error)} />}
      {users.data && (
        <div className="table-wrap">
          <table className="table table--cards">
            <thead>
              <tr>
                <th scope="col">{t('admin.users.colUser')}</th>
                <th scope="col">{t('admin.users.colRole')}</th>
                <th scope="col">{t('admin.users.colEmployee')}</th>
                <th scope="col">{t('admin.users.colLastLogin')}</th>
                <th scope="col">
                  <span className="visually-hidden">{t('manage.colActions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.data.map((u) => {
                const self = u.id === me?.id;
                return (
                  <tr key={u.id} className={u.status === 'disabled' ? 'is-inactive' : undefined}>
                    <td data-label={t('admin.users.colUser')}>
                      <strong>{u.displayName}</strong>
                      {self && <span className="muted"> ({t('admin.users.you')})</span>}
                      <div className="muted small">
                        {u.username} · {u.status === 'active' ? t('admin.users.active') : t('admin.users.disabled')}
                      </div>
                    </td>
                    <td data-label={t('admin.users.colRole')}>
                      <label className="visually-hidden" htmlFor={`role-${u.id}`}>
                        {t('admin.users.colRole')}
                      </label>
                      <select id={`role-${u.id}`} className="select select--small" value={u.role} disabled={self} onChange={(e) => void patch(u, { role: e.target.value })}>
                        {ROLES.map((r) => (
                          <option key={r} value={r} disabled={r === 'employee' && u.employeeId == null}>
                            {t(`role.${r}`)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td data-label={t('admin.users.colEmployee')}>
                      <label className="visually-hidden" htmlFor={`profile-${u.id}`}>
                        {t('admin.users.linkProfile')}
                      </label>
                      <select
                        id={`profile-${u.id}`}
                        className="select select--small"
                        value={u.employeeId ?? ''}
                        onChange={(e) => void patch(u, { employeeId: e.target.value ? Number(e.target.value) : null })}
                      >
                        <option value="">{t('admin.users.noProfile')}</option>
                        {(employees.data ?? [])
                          .filter((e) => e.id === u.employeeId || (e.status === 'active' && e.userId == null))
                          .map((e) => (
                            <option key={e.id} value={e.id}>
                              {e.firstName} {e.lastName}
                            </option>
                          ))}
                      </select>
                      {u.employeeId != null && (
                        <div className="small">
                          <Link to={`/people/${u.employeeId}`}>{u.employeeName}</Link>
                        </div>
                      )}
                    </td>
                    <td data-label={t('admin.users.colLastLogin')}>
                      {u.lastLoginAt ? formatDate(u.lastLoginAt, true) : u.hasPassword ? t('admin.users.never') : t('admin.users.notActivated')}
                      <div className="muted small">{t('admin.users.sessions', { n: u.activeSessions })}</div>
                    </td>
                    <td className="row-actions">
                      {u.status === 'active' && (
                        <button
                          type="button"
                          className="btn btn--ghost btn--small"
                          onClick={async () => {
                            try {
                              const result = await api<InviteLinkDto>('POST', `/api/admin/users/${u.id}/reset-link`, {});
                              setLink({ result, title: t('admin.users.resetTitle', { name: u.displayName }), text: t('admin.users.resetText') });
                            } catch (err) {
                              toast(errorText(t, err), 'error');
                            }
                          }}
                        >
                          {t('admin.users.resetLink')}
                        </button>
                      )}
                      {u.activeSessions > 0 && !self && (
                        <button
                          type="button"
                          className="btn btn--ghost btn--small"
                          onClick={async () => {
                            try {
                              await api('POST', `/api/admin/users/${u.id}/revoke-sessions`, {});
                              toast(t('admin.users.signedOut'));
                              refresh();
                            } catch (err) {
                              toast(errorText(t, err), 'error');
                            }
                          }}
                        >
                          {t('admin.users.signOutAll')}
                        </button>
                      )}
                      {!self &&
                        (u.status === 'active' ? (
                          <button
                            type="button"
                            className="btn btn--ghost btn--small btn--danger-text"
                            onClick={async () => {
                              if (await confirm(t('admin.users.disableConfirm', { name: u.displayName }), { danger: true, confirmLabel: t('admin.users.disable') })) {
                                await patch(u, { status: 'disabled' });
                              }
                            }}
                          >
                            {t('admin.users.disable')}
                          </button>
                        ) : (
                          <button type="button" className="btn btn--ghost btn--small" onClick={() => void patch(u, { status: 'active' })}>
                            {t('admin.users.enable')}
                          </button>
                        ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <section className="panel" aria-labelledby="invite-person">
        <h2 id="invite-person" className="section-title">
          {t('admin.invite.title')}
        </h2>
        <p className="muted small">{t('admin.invite.text')}</p>
        <form className="form form--inline" onSubmit={invite}>
          <Field label={t('admin.invite.role')}>
            {(id) => (
              <select id={id} className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {t(`role.${r}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('admin.invite.employee')}>
            {(id) => (
              <select id={id} className="select" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
                <option value="">{t('admin.invite.noEmployee')}</option>
                {withoutAccount.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.firstName} {e.lastName}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {!employeeId && (
            <Field label={t('admin.invite.name')}>
              {(id) => <input id={id} className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />}
            </Field>
          )}
          <InlineError message={error} />
          <button type="submit" className="btn btn--primary" disabled={!employeeId && !name.trim()}>
            {t('admin.invite.submit')}
          </button>
        </form>
        {invites.data && invites.data.length > 0 && (
          <>
            <h3 className="subsection-title">{t('manage.invitesTitle')}</h3>
            <ul className="plain-list">
              {invites.data.map((i) => (
                <li key={i.id} className="plain-list__row">
                  <span>
                    <strong>{i.employeeName ?? i.displayName ?? t('common.none')}</strong> · {i.kind === 'reset' ? t('admin.users.resetLink') : t(`role.${i.role}`)} ·{' '}
                    {t('manage.expires', { date: formatDate(i.expiresAt, true) })}
                  </span>
                  <button
                    type="button"
                    className="btn btn--ghost btn--small"
                    onClick={async () => {
                      if (await confirm(t('manage.revokeConfirm'), { danger: true, confirmLabel: t('manage.revoke') })) {
                        try {
                          await api('DELETE', `/api/invites/${i.id}`);
                          toast(t('manage.revoked'));
                          refresh();
                        } catch (err) {
                          toast(errorText(t, err), 'error');
                        }
                      }
                    }}
                  >
                    {t('manage.revoke')}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      <InviteLinkDialog result={link?.result ?? null} title={link?.title ?? ''} text={link?.text ?? ''} onClose={() => setLink(null)} />
    </>
  );
}

// ---------------------------------------------------- companies and teams

function NameDialog({ title, label, initial, onSave, onClose }: { title: string; label: string; initial: { name: string; sortOrder: number } | null; onSave: (v: { name: string; sortOrder: number }) => Promise<void>; onClose: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState(initial?.name ?? '');
  const [order, setOrder] = useState(String(initial?.sortOrder ?? 100));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setName(initial?.name ?? '');
    setOrder(String(initial?.sortOrder ?? 100));
    setError(null);
  }, [initial]);
  return (
    <Dialog open={initial !== null} onClose={onClose} title={title}>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await onSave({ name, sortOrder: Number(order) || 0 });
          } catch (err) {
            setError(errorText(t, err));
          }
        }}
      >
        <Field label={label}>{(id) => <input id={id} className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} required />}</Field>
        <Field label={t('admin.structure.sortOrder')}>
          {(id) => <input id={id} className="input input--short" type="number" min={0} max={10000} value={order} onChange={(e) => setOrder(e.target.value)} />}
        </Field>
        <InlineError message={error} />
        <div className="actions">
          <button type="submit" className="btn btn--primary" disabled={!name.trim()}>
            {t('common.save')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function StructureTab() {
  const { t } = useI18n();
  const { toast, confirm } = useUi();
  const dir = useLoad(() => api<DirectoryDto>('GET', '/api/directory'), []);
  const [newCompany, setNewCompany] = useState('');
  const [newTeam, setNewTeam] = useState<Record<number, string>>({});
  const [edit, setEdit] = useState<{ kind: 'company'; item: CompanyDto } | { kind: 'team'; item: TeamDto } | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      toast(t('admin.structure.saved'));
      void dir.reload();
      return true;
    } catch (err) {
      toast(errorText(t, err), 'error');
      return false;
    }
  };

  if (dir.loading && !dir.data) return <Spinner />;
  if (!dir.data) return <StateMessage tone="error" title={errorText(t, dir.error)} />;

  return (
    <>
      <form
        className="form form--inline panel"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await run(() => api('POST', '/api/admin/companies', { name: newCompany }))) setNewCompany('');
        }}
      >
        <Field label={t('admin.structure.companyName')}>{(id) => <input id={id} className="input" maxLength={80} value={newCompany} onChange={(e) => setNewCompany(e.target.value)} />}</Field>
        <button type="submit" className="btn btn--primary" disabled={!newCompany.trim()}>
          {t('admin.structure.addCompany')}
        </button>
      </form>

      {dir.data.companies.map((c) => {
        const teams = dir.data!.teams.filter((tm) => tm.companyId === c.id);
        return (
          <section key={c.id} className={`panel structure${c.active ? '' : ' is-inactive'}`} aria-labelledby={`co-${c.id}`}>
            <div className="structure__head">
              <h2 id={`co-${c.id}`} className="section-title">
                {c.name}
                {!c.active && <span className="tag">{t('admin.structure.inactive')}</span>}
              </h2>
              <div className="row-actions">
                <button type="button" className="btn btn--ghost btn--small" onClick={() => setEdit({ kind: 'company', item: c })}>
                  {t('admin.structure.rename')}
                </button>
                <button type="button" className="btn btn--ghost btn--small" onClick={() => void run(() => api('PATCH', `/api/admin/companies/${c.id}`, { active: !c.active }))}>
                  {c.active ? t('admin.structure.deactivate') : t('admin.structure.activate')}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--small btn--danger-text"
                  onClick={async () => {
                    if (await confirm(t('admin.structure.deleteConfirm', { name: c.name }), { danger: true, confirmLabel: t('common.delete') })) void run(() => api('DELETE', `/api/admin/companies/${c.id}`));
                  }}
                >
                  {t('common.delete')}
                </button>
              </div>
            </div>
            {teams.length === 0 && <p className="muted small">{t('admin.structure.noTeams')}</p>}
            <ul className="plain-list">
              {teams.map((tm) => (
                <li key={tm.id} className={`plain-list__row${tm.active ? '' : ' is-inactive'}`}>
                  <span>
                    {tm.name} {!tm.active && <span className="tag">{t('admin.structure.inactive')}</span>}
                  </span>
                  <span className="row-actions">
                    <button type="button" className="btn btn--ghost btn--small" onClick={() => setEdit({ kind: 'team', item: tm })}>
                      {t('admin.structure.rename')}
                    </button>
                    <button type="button" className="btn btn--ghost btn--small" onClick={() => void run(() => api('PATCH', `/api/admin/teams/${tm.id}`, { active: !tm.active }))}>
                      {tm.active ? t('admin.structure.deactivate') : t('admin.structure.activate')}
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--small btn--danger-text"
                      onClick={async () => {
                        if (await confirm(t('admin.structure.deleteConfirm', { name: tm.name }), { danger: true, confirmLabel: t('common.delete') })) void run(() => api('DELETE', `/api/admin/teams/${tm.id}`));
                      }}
                    >
                      {t('common.delete')}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            <form
              className="form form--inline"
              onSubmit={async (e) => {
                e.preventDefault();
                if (await run(() => api('POST', '/api/admin/teams', { companyId: c.id, name: newTeam[c.id] ?? '' }))) setNewTeam({ ...newTeam, [c.id]: '' });
              }}
            >
              <Field label={t('admin.structure.teamName')}>
                {(id) => <input id={id} className="input" maxLength={80} value={newTeam[c.id] ?? ''} onChange={(e) => setNewTeam({ ...newTeam, [c.id]: e.target.value })} />}
              </Field>
              <button type="submit" className="btn btn--secondary" disabled={!(newTeam[c.id] ?? '').trim()}>
                {t('admin.structure.addTeam')}
              </button>
            </form>
          </section>
        );
      })}

      <NameDialog
        title={edit?.kind === 'team' ? t('admin.structure.editTeam') : t('admin.structure.editCompany')}
        label={edit?.kind === 'team' ? t('admin.structure.teamName') : t('admin.structure.companyName')}
        initial={edit ? { name: edit.item.name, sortOrder: edit.item.sortOrder } : null}
        onClose={() => setEdit(null)}
        onSave={async (v) => {
          if (!edit) return;
          await api('PATCH', `/api/admin/${edit.kind === 'team' ? 'teams' : 'companies'}/${edit.item.id}`, v);
          toast(t('admin.structure.saved'));
          setEdit(null);
          void dir.reload();
        }}
      />
    </>
  );
}

// --------------------------------------------------------------- audit log

const AUDIT_FILTERS = ['', 'auth', 'invite', 'employee', 'user', 'company', 'team', 'backup', 'export', 'settings'] as const;

function AuditTab() {
  const { t, formatDate } = useI18n();
  const [filter, setFilter] = useState('');
  const [items, setItems] = useState<AuditEntryDto[]>([]);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  const load = async (before?: number, reset = false) => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ limit: '50' });
      if (before) qs.set('before', String(before));
      if (filter) qs.set('action', `${filter}.`);
      const page = await api<AuditEntryDto[]>('GET', `/api/admin/audit?${qs.toString()}`);
      setItems((prev) => (reset ? page : [...prev, ...page]));
      setDone(page.length < 50);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(undefined, true);
  }, [filter]);

  return (
    <>
      <label className="filter">
        <span className="filter__label">{t('admin.audit.filter')}</span>
        <select className="select" value={filter} onChange={(e) => setFilter(e.target.value)}>
          {AUDIT_FILTERS.map((f) => (
            <option key={f} value={f}>
              {t(f ? (`admin.audit.${f}` as StringKey) : 'admin.audit.all')}
            </option>
          ))}
        </select>
      </label>
      {error != null && <StateMessage tone="error" title={errorText(t, error)} />}
      {!loading && items.length === 0 && !error && <p className="muted">{t('admin.audit.empty')}</p>}
      {items.length > 0 && (
        <div className="table-wrap">
          <table className="table table--cards table--audit">
            <thead>
              <tr>
                <th scope="col">{t('admin.audit.colTime')}</th>
                <th scope="col">{t('admin.audit.colActor')}</th>
                <th scope="col">{t('admin.audit.colAction')}</th>
                <th scope="col">{t('admin.audit.colDetails')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <td data-label={t('admin.audit.colTime')}>{formatDate(a.at, true)}</td>
                  <td data-label={t('admin.audit.colActor')}>
                    {a.actor}
                    {a.ip && <div className="muted small">{a.ip}</div>}
                  </td>
                  <td data-label={t('admin.audit.colAction')}>
                    <code>{a.action}</code>
                    {a.entityType && (
                      <div className="muted small">
                        {a.entityType} {a.entityId ?? ''}
                      </div>
                    )}
                  </td>
                  <td data-label={t('admin.audit.colDetails')}>
                    <code className="details">{Object.keys(a.details).length ? JSON.stringify(a.details) : ''}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {loading && <Spinner />}
      {!done && items.length > 0 && !loading && (
        <button type="button" className="btn btn--secondary" onClick={() => void load(items.at(-1)?.id)}>
          {t('admin.audit.more')}
        </button>
      )}
    </>
  );
}

// ------------------------------------------------------- backup and export

interface StatusDto {
  version: string;
  schemaVersion: number;
  baseUrl: string;
  employees: number;
  withPhoto: number;
  users: number;
  demoEmployees: number;
  lastHostBackup: { at?: string; file?: string; size?: number } | null;
}

function BackupTab() {
  const { t, formatDate } = useI18n();
  const { toast, confirm } = useUi();
  const status = useLoad(() => api<StatusDto>('GET', '/api/admin/status'), []);
  const backups = useLoad(() => api<BackupFileDto[]>('GET', '/api/admin/backups'), []);
  const [busy, setBusy] = useState(false);
  const size = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

  return (
    <>
      <section className="panel" aria-labelledby="sys-title">
        <h2 id="sys-title" className="section-title">
          {t('admin.backup.status')}
        </h2>
        {status.data ? (
          <dl className="facts facts--compact">
            <div className="facts__row">
              <dt>{t('admin.backup.version')}</dt>
              <dd>{status.data.version}</dd>
            </div>
            <div className="facts__row">
              <dt>{t('admin.backup.schema')}</dt>
              <dd>{status.data.schemaVersion}</dd>
            </div>
            <div className="facts__row">
              <dt>{t('admin.backup.address')}</dt>
              <dd>{status.data.baseUrl}</dd>
            </div>
            <div className="facts__row">
              <dt>{t('admin.backup.counts')}</dt>
              <dd>
                {status.data.employees} / {status.data.withPhoto} / {status.data.users}
              </dd>
            </div>
            <div className="facts__row">
              <dt>{t('admin.backup.lastHost')}</dt>
              <dd>
                {status.data.lastHostBackup?.at
                  ? `${formatDate(status.data.lastHostBackup.at, true)} · ${status.data.lastHostBackup.file ?? ''}${status.data.lastHostBackup.size ? ` · ${size(status.data.lastHostBackup.size)}` : ''}`
                  : t('admin.backup.noHost')}
              </dd>
            </div>
          </dl>
        ) : (
          <Spinner />
        )}
      </section>

      <section className="panel" aria-labelledby="bk-title">
        <h2 id="bk-title" className="section-title">
          {t('admin.backup.panelTitle')}
        </h2>
        <p className="muted small">{t('admin.backup.panelText')}</p>
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api('POST', '/api/admin/backups', {});
              toast(t('admin.backup.created'));
              void backups.reload();
            } catch (err) {
              toast(errorText(t, err), 'error');
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? t('common.saving') : t('admin.backup.create')}
        </button>
        {backups.data && backups.data.length === 0 && <p className="muted">{t('admin.backup.none')}</p>}
        {backups.data && backups.data.length > 0 && (
          <ul className="plain-list">
            {backups.data.map((b) => (
              <li key={b.name} className="plain-list__row">
                <span>
                  {formatDate(b.createdAt, true)} · {size(b.size)}
                  <div className="muted small">{b.name}</div>
                </span>
                <a className="btn btn--ghost btn--small" href={`/api/admin/backups/${encodeURIComponent(b.name)}`} download>
                  {t('admin.backup.download')}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" aria-labelledby="ex-title">
        <h2 id="ex-title" className="section-title">
          {t('admin.backup.exportTitle')}
        </h2>
        <p className="muted small">{t('admin.backup.exportText')}</p>
        <div className="actions">
          <a className="btn btn--secondary" href="/api/admin/export.json" download>
            {t('admin.backup.exportJson')}
          </a>
          <a className="btn btn--secondary" href="/api/admin/export.csv" download>
            {t('admin.backup.exportCsv')}
          </a>
        </div>
      </section>

      {status.data && status.data.demoEmployees > 0 && (
        <section className="panel" aria-labelledby="demo-title">
          <h2 id="demo-title" className="section-title">
            {t('admin.backup.demoTitle')}
          </h2>
          <p>{t('admin.backup.demoText', { n: status.data.demoEmployees })}</p>
          <button
            type="button"
            className="btn btn--danger"
            onClick={async () => {
              if (!(await confirm(t('admin.backup.demoRemove'), { danger: true, confirmLabel: t('admin.backup.demoRemove') }))) return;
              try {
                await api('POST', '/api/admin/demo/remove', {});
                toast(t('admin.backup.demoRemoved'));
                void status.reload();
              } catch (err) {
                toast(errorText(t, err), 'error');
              }
            }}
          >
            {t('admin.backup.demoRemove')}
          </button>
        </section>
      )}
    </>
  );
}

// ---------------------------------------------------------------- settings

function SettingsTab() {
  const { t } = useI18n();
  const { toast } = useUi();
  const { reload } = useSession();
  const settings = useLoad(() => api<SettingsDto>('GET', '/api/admin/settings'), []);
  const [form, setForm] = useState<SettingsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (settings.data) setForm(settings.data);
  }, [settings.data]);
  if (!form) return settings.error ? <StateMessage tone="error" title={errorText(t, settings.error)} /> : <Spinner />;
  return (
    <form
      className="form panel"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          setForm(await api<SettingsDto>('PUT', '/api/admin/settings', form));
          toast(t('admin.settings.saved'));
          void reload();
        } catch (err) {
          setError(errorText(t, err));
        }
      }}
    >
      <Field label={t('admin.settings.siteTitle')}>{(id) => <input id={id} className="input" maxLength={60} value={form.siteTitle} onChange={(e) => setForm({ ...form, siteTitle: e.target.value })} />}</Field>
      <Field label={t('admin.settings.inviteTtl')}>
        {(id) => <input id={id} className="input input--short" type="number" min={1} max={336} value={form.inviteTtlHours} onChange={(e) => setForm({ ...form, inviteTtlHours: Number(e.target.value) })} />}
      </Field>
      <Field label={t('admin.settings.privacyContact')} hint={t('admin.settings.privacyContactHint')}>
        {(id, d) => <input id={id} aria-describedby={d} className="input" maxLength={200} value={form.privacyContact} onChange={(e) => setForm({ ...form, privacyContact: e.target.value })} />}
      </Field>
      <Field label={t('admin.settings.defaultLocale')}>
        {(id) => (
          <select id={id} className="select" value={form.defaultLocale} onChange={(e) => setForm({ ...form, defaultLocale: e.target.value as Locale })}>
            {LOCALES.map((l) => (
              <option key={l} value={l}>
                {l === 'en' ? 'English' : 'Русский'}
              </option>
            ))}
          </select>
        )}
      </Field>
      <InlineError message={error} />
      <div className="actions">
        <button type="submit" className="btn btn--primary">
          {t('common.saveChanges')}
        </button>
      </div>
    </form>
  );
}

export function AdminPage() {
  const { t } = useI18n();
  const { path } = useLocation();
  const tab: Tab = ((matchPath('/admin/:tab', path)?.tab as Tab | undefined) ?? 'users');
  const current = TABS.includes(tab) ? tab : 'users';

  return (
    <div className="page page--wide">
      <div className="page__head">
        <h1>{t('admin.title')}</h1>
      </div>
      <nav className="tabs" aria-label={t('admin.title')}>
        {TABS.map((x) => (
          <Link key={x} to={x === 'users' ? '/admin' : `/admin/${x}`} className={`tabs__tab${x === current ? ' is-active' : ''}`} aria-current={x === current ? 'page' : undefined}>
            {t(`admin.tab.${x}`)}
          </Link>
        ))}
      </nav>
      <div className="tab-panel">
        {current === 'users' && <UsersTab />}
        {current === 'structure' && <StructureTab />}
        {current === 'audit' && <AuditTab />}
        {current === 'backup' && <BackupTab />}
        {current === 'settings' && <SettingsTab />}
      </div>
    </div>
  );
}
