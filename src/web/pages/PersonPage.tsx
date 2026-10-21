import type { EmployeeDto } from '../../shared/types.js';
import { AvailabilityBadge, Avatar, Icon, Spinner, StateMessage } from '../components/ui';
import { ApiError, api, errorText } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Link } from '../lib/router';
import { useSession } from '../lib/session';
import { useLoad } from '../lib/util';

export function PersonPage({ id }: { id: string }) {
  const { t, formatDate, languageName } = useI18n();
  const { user } = useSession();
  const { data: e, error, loading, reload } = useLoad(() => api<EmployeeDto>('GET', `/api/employees/${encodeURIComponent(id)}`), [id]);

  const back = (
    <Link to="/" className="back-link">
      <Icon name="back" /> {t('person.back')}
    </Link>
  );

  if (loading && !e) return <div className="page">{back}<Spinner /></div>;
  if (error || !e) {
    const missing = error instanceof ApiError && (error.status === 404 || error.status === 400);
    return (
      <div className="page">
        {back}
        <h1 className="visually-hidden">{t('dir.title')}</h1>
        <StateMessage
          tone={missing ? 'neutral' : 'error'}
          title={missing ? t('person.notFound') : errorText(t, error)}
          action={
            missing ? undefined : (
              <button type="button" className="btn btn--primary" onClick={() => void reload()}>
                {t('common.retry')}
              </button>
            )
          }
        />
      </div>
    );
  }

  const isMe = user?.employeeId === e.id;
  const canManage = user?.role === 'admin' || user?.role === 'coordinator';

  return (
    <div className="page page--narrow">
      {back}
      <article className="person">
        <div className="person__photo">
          <Avatar first={e.firstName} last={e.lastName} photoUrl={e.photoUrl} size="lg" />
        </div>
        <div className="person__head">
          <h1 className="person__name">
            {e.firstName} {e.lastName}
          </h1>
          {e.officialTitle && <p className="person__title">{e.officialTitle}</p>}
          <p className="person__org">{[e.companyName, e.teamName].filter(Boolean).join(' · ') || t('dir.otherCompany')}</p>
          <div className={`person__avail avail-panel avail-panel--${e.algoritmiAvailability ?? 'unset'}`}>
            <AvailabilityBadge value={e.algoritmiAvailability} long />
          </div>
          {e.status === 'inactive' && <p className="notice">{t('person.inactive')}</p>}
          {e.isDemo && <span className="tag tag--demo">{t('common.demo')}</span>}
        </div>

        <dl className="facts">
          <div className="facts__row">
            <dt>{t('field.profession')}</dt>
            <dd>{e.profession || <span className="muted">{t('common.notProvided')}</span>}</dd>
          </div>
          <div className="facts__row">
            <dt>{t('field.currentWork')}</dt>
            <dd className="prewrap">{e.currentWork || <span className="muted">{t('common.notProvided')}</span>}</dd>
          </div>
          <div className="facts__row">
            <dt>{t('field.languages')}</dt>
            <dd>
              {e.languages.length ? (
                <ul className="chips chips--static">
                  {e.languages.map((l) => (
                    <li key={l} className="chip">
                      {languageName(l)}
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="muted">{t('person.noLanguages')}</span>
              )}
            </dd>
          </div>
        </dl>

        <section className="contacts" aria-labelledby="contacts-title">
          <h2 id="contacts-title" className="section-title">
            {t('person.contacts')}
          </h2>
          <ul className="contacts__list">
            <li>
              <span className="contacts__label">
                <Icon name="mail" /> {t('field.workEmail')}
              </span>
              {e.workEmail ? (
                <a className="contacts__value" href={`mailto:${e.workEmail}`}>
                  {e.workEmail}
                </a>
              ) : (
                <span className="contacts__value muted">{t('common.notProvided')}</span>
              )}
            </li>
            <li>
              <span className="contacts__label">
                <Icon name="phone" /> {t('field.phone')}
              </span>
              {e.phone ? (
                <a className="contacts__value" href={`tel:${e.phone.replace(/[^\d+]/g, '')}`}>
                  {e.phone}
                </a>
              ) : (
                <span className="contacts__value muted">{t('common.notProvided')}</span>
              )}
            </li>
          </ul>
        </section>

        <p className="muted small">{t('person.updated', { date: formatDate(e.updatedAt) })}</p>
        <div className="actions">
          {isMe && (
            <Link to="/me" className="btn btn--secondary">
              {t('person.editOwn')}
            </Link>
          )}
          {canManage && (
            <Link to={`/manage?edit=${e.id}`} className="btn btn--ghost">
              {t('person.editManage')}
            </Link>
          )}
        </div>
      </article>
    </div>
  );
}
