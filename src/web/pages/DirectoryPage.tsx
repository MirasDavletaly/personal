import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { AVAILABILITY } from '../../shared/constants.js';
import type { DirectoryDto, EmployeeDto } from '../../shared/types.js';
import { AvailabilityBadge, Avatar, Icon, Spinner, StateMessage } from '../components/ui';
import { api, errorText } from '../lib/api';
import { countText, useI18n } from '../lib/i18n';
import { Link, setQuery, useLocation } from '../lib/router';
import { useSession } from '../lib/session';
import { fold, useLoad } from '../lib/util';

interface TeamGroup {
  key: string;
  name: string;
  people: EmployeeDto[];
}
interface CompanyGroup {
  key: string;
  name: string;
  count: number;
  teams: TeamGroup[];
}

function PersonCard({ e }: { e: EmployeeDto }) {
  const { t } = useI18n();
  return (
    <li>
      <Link to={`/people/${e.id}`} className={`badge badge--${e.algoritmiAvailability ?? 'unset'}`}>
        <Avatar first={e.firstName} last={e.lastName} photoUrl={e.photoUrl} />
        <span className="badge__body">
          <span className="badge__name">
            {e.firstName} {e.lastName}
          </span>
          {e.officialTitle && <span className="badge__title">{e.officialTitle}</span>}
          {e.profession && e.profession.toLowerCase() !== e.officialTitle.toLowerCase() && <span className="badge__profession">{e.profession}</span>}
        </span>
        <span className="badge__strip">
          <AvailabilityBadge value={e.algoritmiAvailability} />
        </span>
        {e.isDemo && <span className="tag tag--demo">{t('common.demo')}</span>}
      </Link>
    </li>
  );
}

export function DirectoryPage() {
  const { t, locale, languageName } = useI18n();
  const { user } = useSession();
  const { query } = useLocation();
  const { data, error, loading, reload } = useLoad(() => api<DirectoryDto>('GET', '/api/directory'), []);

  const company = query.get('company') ?? '';
  const team = query.get('team') ?? '';
  const lang = query.get('lang') ?? '';
  const avail = query.get('avail') ?? '';
  const [search, setSearch] = useState(query.get('q') ?? '');

  useEffect(() => {
    const h = window.setTimeout(() => setQuery({ q: search.trim() || null }), 250);
    return () => window.clearTimeout(h);
  }, [search]);

  const employees = data?.employees ?? [];
  const usedCompanies = useMemo(() => (data?.companies ?? []).filter((c) => employees.some((e) => e.companyId === c.id)), [data, employees]);
  const usedTeams = useMemo(
    () => (data?.teams ?? []).filter((tm) => (!company || String(tm.companyId) === company) && employees.some((e) => e.teamId === tm.id)),
    [data, employees, company],
  );
  const usedLanguages = useMemo(
    () => [...new Set(employees.flatMap((e) => e.languages))].sort((a, b) => languageName(a).localeCompare(languageName(b), locale)),
    [employees, languageName, locale],
  );

  const filtered = useMemo(() => {
    const words = fold(search).split(/\s+/).filter(Boolean);
    return employees.filter((e) => {
      if (company && String(e.companyId ?? 'none') !== company) return false;
      if (team && String(e.teamId ?? 'none') !== team) return false;
      if (lang && !e.languages.includes(lang)) return false;
      if (avail && (e.algoritmiAvailability ?? 'unset') !== avail) return false;
      if (!words.length) return true;
      const hay = fold([e.firstName, e.lastName, e.officialTitle, e.profession, e.currentWork].join(' '));
      return words.every((w) => hay.includes(w));
    });
  }, [employees, search, company, team, lang, avail]);

  const groups = useMemo<CompanyGroup[]>(() => {
    if (!data) return [];
    const companyOrder = [...data.companies.map((c) => ({ key: String(c.id), name: c.name })), { key: 'none', name: t('dir.otherCompany') }];
    const teamOrder = data.teams;
    return companyOrder
      .map((c) => {
        const people = filtered.filter((e) => String(e.companyId ?? 'none') === c.key);
        const teams: TeamGroup[] = [
          ...teamOrder.filter((tm) => String(tm.companyId) === c.key).map((tm) => ({ key: String(tm.id), name: tm.name })),
          { key: 'none', name: t('dir.otherTeam') },
        ]
          .map((tm) => ({ ...tm, people: people.filter((e) => String(e.teamId ?? 'none') === tm.key) }))
          .filter((tm) => tm.people.length > 0);
        return { key: c.key, name: c.name, count: people.length, teams };
      })
      .filter((c) => c.count > 0);
  }, [data, filtered, t]);

  const own = user?.employeeId != null ? employees.find((e) => e.id === user.employeeId) : undefined;
  const anyFilter = !!(search.trim() || company || team || lang || avail);
  const clear = () => {
    setSearch('');
    setQuery({ q: null, company: null, team: null, lang: null, avail: null });
  };

  return (
    <div className="page">
      <div className="page__head">
        <h1>{t('dir.title')}</h1>
        <p className="muted">{t('app.tagline')}</p>
      </div>

      {own && own.completeness < 100 && (
        <div className="nudge">
          <p>{t('dir.ownIncomplete', { percent: own.completeness })}</p>
          <Link to="/me" className="btn btn--secondary btn--small">
            {t('dir.ownIncompleteAction')}
          </Link>
        </div>
      )}

      <div className="toolbar" role="search">
        <div className="search">
          <label htmlFor="dir-search" className="visually-hidden">
            {t('dir.search')}
          </label>
          <Icon name="search" />
          <input
            id="dir-search"
            className="input search__input"
            type="search"
            placeholder={t('dir.searchHint')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoComplete="off"
            enterKeyHint="search"
          />
        </div>
        <div className="filters">
          <label className="filter">
            <span className="filter__label">{t('dir.company')}</span>
            <select className="select" value={company} onChange={(e) => setQuery({ company: e.target.value || null, team: null })}>
              <option value="">{t('dir.anyCompany')}</option>
              {usedCompanies.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="filter">
            <span className="filter__label">{t('dir.team')}</span>
            <select className="select" value={team} onChange={(e) => setQuery({ team: e.target.value || null })}>
              <option value="">{t('dir.anyTeam')}</option>
              {usedTeams.map((tm) => (
                <option key={tm.id} value={String(tm.id)}>
                  {company ? tm.name : `${tm.name} · ${data?.companies.find((c) => c.id === tm.companyId)?.name ?? ''}`}
                </option>
              ))}
            </select>
          </label>
          <label className="filter">
            <span className="filter__label">{t('dir.language')}</span>
            <select className="select" value={lang} onChange={(e) => setQuery({ lang: e.target.value || null })}>
              <option value="">{t('dir.anyLanguage')}</option>
              {usedLanguages.map((l) => (
                <option key={l} value={l}>
                  {languageName(l)}
                </option>
              ))}
            </select>
          </label>
          <label className="filter">
            <span className="filter__label">{t('dir.availability')}</span>
            <select className="select" value={avail} onChange={(e) => setQuery({ avail: e.target.value || null })}>
              <option value="">{t('dir.anyAvailability')}</option>
              {AVAILABILITY.map((a) => (
                <option key={a} value={a}>
                  {t(`avail.${a}`)}
                </option>
              ))}
              <option value="unset">{t('avail.unset')}</option>
            </select>
          </label>
        </div>
        <div className="toolbar__meta">
          <p className="count" aria-live="polite">
            {data ? countText(t, locale, filtered.length) : ''}
          </p>
          {anyFilter && (
            <button type="button" className="btn btn--ghost btn--small" onClick={clear}>
              {t('common.clearFilters')}
            </button>
          )}
        </div>
      </div>

      {loading && !data && <Spinner />}
      {error != null && (
        <StateMessage
          tone="error"
          title={t('dir.loadError')}
          text={errorText(t, error)}
          action={
            <button type="button" className="btn btn--primary" onClick={() => void reload()}>
              {t('common.retry')}
            </button>
          }
        />
      )}
      {data && employees.length === 0 && <StateMessage title={t('dir.empty')} text={t('dir.emptyHint')} />}
      {data && employees.length > 0 && filtered.length === 0 && (
        <StateMessage
          title={t('dir.noResults')}
          text={t('dir.noResultsHint')}
          action={
            <button type="button" className="btn btn--secondary" onClick={clear}>
              {t('common.clearFilters')}
            </button>
          }
        />
      )}

      {groups.map((g) => (
        <section key={g.key} className="group" aria-labelledby={`company-${g.key}`}>
          <h2 id={`company-${g.key}`} className="group__title">
            {g.name}
            <span className="group__count">{g.count}</span>
          </h2>
          <div className="group__teams">
            {g.teams.map((tm) => (
              // --n: cards in the team (max 6), so small teams sit side by side on wide screens.
              <div key={tm.key} className="team" style={{ '--n': Math.min(tm.people.length, 6) } as CSSProperties}>
                <h3 className="team__title">{tm.name}</h3>
                <ul className="grid">
                  {tm.people.map((e) => (
                    <PersonCard key={e.id} e={e} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
