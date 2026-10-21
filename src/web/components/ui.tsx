import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { LANGUAGE_CODES, type Availability } from '../../shared/constants.js';
import { useI18n } from '../lib/i18n';
import { copyText, initials } from '../lib/util';

// ------------------------------------------------------------------ avatar

function hue(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 6;
}

export function Avatar({ first, last, photoUrl, size = 'md' }: { first: string; last: string; photoUrl: string | null; size?: 'sm' | 'md' | 'lg' }) {
  if (photoUrl) {
    return (
      <span className={`avatar avatar--${size}`}>
        <img src={photoUrl} alt="" loading="lazy" decoding="async" width={512} height={512} />
      </span>
    );
  }
  return (
    <span className={`avatar avatar--${size} avatar--initials avatar--c${hue(first + last)}`} aria-hidden="true">
      {initials(first, last)}
    </span>
  );
}

// ------------------------------------------------------------ availability

export function AvailabilityBadge({ value, long = false }: { value: Availability | null; long?: boolean }) {
  const { t } = useI18n();
  const label = t(value ? (`avail.${value}` as const) : 'avail.unset');
  return (
    <span className={`avail avail--${value ?? 'unset'}`}>
      <span className="avail__dot" aria-hidden="true" />
      <span className="avail__label">{long ? t('avail.label') : t('avail.short')}:</span> <strong>{label}</strong>
    </span>
  );
}

// ------------------------------------------------------------------ states

export function Spinner({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <div className="state" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{label ?? t('common.loading')}</span>
    </div>
  );
}

export function StateMessage({ title, text, action, tone = 'neutral' }: { title: string; text?: string; action?: ReactNode; tone?: 'neutral' | 'error' }) {
  return (
    <div className={`state state--${tone}`} role={tone === 'error' ? 'alert' : undefined}>
      <p className="state__title">{title}</p>
      {text && <p className="state__text">{text}</p>}
      {action}
    </div>
  );
}

export function InlineError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="form-error" role="alert">
      {message}
    </p>
  );
}

// ------------------------------------------------------------------ dialog

export function Dialog({ open, onClose, title, children, wide = false }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { t } = useI18n();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`dialog${wide ? ' dialog--wide' : ''}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {open && (
        <>
          <div className="dialog__head">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="icon-btn" onClick={onClose} aria-label={t('common.close')}>
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <div className="dialog__body">{children}</div>
        </>
      )}
    </dialog>
  );
}

// ------------------------------------------------------- toasts & confirm

interface ConfirmRequest {
  message: string;
  confirmLabel: string;
  danger: boolean;
  resolve: (ok: boolean) => void;
}

interface Ui {
  toast: (message: string, tone?: 'ok' | 'error') => void;
  confirm: (message: string, opts?: { confirmLabel?: string; danger?: boolean }) => Promise<boolean>;
}

const UiCtx = createContext<Ui | null>(null);

export function UiProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [toasts, setToasts] = useState<{ id: number; message: string; tone: 'ok' | 'error' }[]>([]);
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const nextId = useRef(1);

  const toast = useCallback<Ui['toast']>((message, tone = 'ok') => {
    const id = nextId.current++;
    setToasts((list) => [...list.slice(-2), { id, message, tone }]);
    window.setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 4000);
  }, []);

  const confirm = useCallback<Ui['confirm']>(
    (message, opts = {}) =>
      new Promise<boolean>((resolve) => setRequest({ message, confirmLabel: opts.confirmLabel ?? t('common.confirm'), danger: !!opts.danger, resolve })),
    [t],
  );

  const close = (ok: boolean) => {
    request?.resolve(ok);
    setRequest(null);
  };

  return (
    <UiCtx.Provider value={{ toast, confirm }}>
      {children}
      <div className="toasts" aria-live="polite" aria-atomic="false">
        {toasts.map((x) => (
          <div key={x.id} className={`toast toast--${x.tone}`} role={x.tone === 'error' ? 'alert' : 'status'}>
            {x.message}
          </div>
        ))}
      </div>
      <Dialog open={!!request} onClose={() => close(false)} title={t('common.confirm')}>
        <p>{request?.message}</p>
        <div className="actions">
          <button type="button" className={`btn ${request?.danger ? 'btn--danger' : 'btn--primary'}`} onClick={() => close(true)}>
            {request?.confirmLabel}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => close(false)}>
            {t('common.cancel')}
          </button>
        </div>
      </Dialog>
    </UiCtx.Provider>
  );
}

export function useUi(): Ui {
  const v = useContext(UiCtx);
  if (!v) throw new Error('UiProvider missing');
  return v;
}

// ------------------------------------------------------------------ fields

export function Field({ label, hint, error, children, optional = false }: { label: string; hint?: string; error?: string; children: (id: string, describedBy: string | undefined) => ReactNode; optional?: boolean }) {
  const id = useId();
  const { t } = useI18n();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`field${error ? ' field--invalid' : ''}`}>
      <label htmlFor={id} className="field__label">
        {label}
        {optional && <span className="field__optional"> ({t('common.optional')})</span>}
      </label>
      {children(id, describedBy)}
      {hint && (
        <p id={hintId} className="field__hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errId} className="field__error">
          {error}
        </p>
      )}
    </div>
  );
}

export function LanguagePicker({ value, onChange, legend }: { value: string[]; onChange: (v: string[]) => void; legend: string }) {
  const { languageName } = useI18n();
  const toggle = (code: string) => onChange(value.includes(code) ? value.filter((c) => c !== code) : [...value, code]);
  return (
    <fieldset className="field chips-field">
      <legend className="field__label">{legend}</legend>
      <div className="chips">
        {LANGUAGE_CODES.map((code) => (
          <label key={code} className={`chip-check${value.includes(code) ? ' is-on' : ''}`}>
            <input type="checkbox" checked={value.includes(code)} onChange={() => toggle(code)} />
            <span>{languageName(code)}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function Completeness({ percent, label }: { percent: number; label: string }) {
  return (
    <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={label}>
      <span className="meter__fill" style={{ width: `${percent}%` }} />
    </div>
  );
}

export function CopyLink({ link }: { link: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const id = useId();
  return (
    <div className="copy-link">
      <label htmlFor={id} className="visually-hidden">
        {t('common.copy')}
      </label>
      <input id={id} className="input copy-link__input" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
      <button type="button" className="btn btn--primary" onClick={async () => setState((await copyText(link)) ? 'ok' : 'fail')}>
        {t('common.copy')}
      </button>
      <p className="copy-link__status" role="status">
        {state === 'ok' ? t('common.copied') : state === 'fail' ? t('common.copyFailed') : ''}
      </p>
    </div>
  );
}

// ------------------------------------------------------------------- icons

export function Icon({ name }: { name: 'lock' | 'mail' | 'phone' | 'camera' | 'search' | 'check' | 'back' }) {
  const paths: Record<typeof name, ReactNode> = {
    lock: <path d="M7 11V8a5 5 0 0110 0v3M6 11h12v9H6z" />,
    mail: <path d="M4 6h16v12H4zM4 7l8 6 8-6" />,
    phone: <path d="M7 3h4l1 5-2.5 1.5a11 11 0 005 5L16 12l5 1v4a2 2 0 01-2 2A16 16 0 015 5a2 2 0 012-2z" />,
    camera: <path d="M4 8h3l2-3h6l2 3h3v11H4zM12 17a4 4 0 100-8 4 4 0 000 8z" />,
    search: <path d="M11 18a7 7 0 100-14 7 7 0 000 14zM16 16l5 5" />,
    check: <path d="M5 12l5 5 9-10" />,
    back: <path d="M15 5l-7 7 7 7" />,
  };
  return (
    <svg className="icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  );
}
