import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Locale } from '../../shared/constants.js';
import { en, ru, type StringKey } from './strings';

const STORAGE_KEY = 'tkz.locale';
const DICTS: Record<Locale, Record<StringKey, string>> = { en, ru };

export function storedLocale(): Locale | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'en' || v === 'ru' ? v : null;
  } catch {
    return null;
  }
}

function storeLocale(l: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, l);
  } catch {
    /* private mode: the choice lasts for this page only */
  }
}

export type T = (key: StringKey, vars?: Record<string, string | number>) => string;

interface I18n {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: T;
  formatDate: (iso: string, withTime?: boolean) => string;
  languageName: (code: string) => string;
}

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ initial, children, onChange }: { initial: Locale; children: ReactNode; onChange?: (l: Locale) => void }) {
  const [locale, setLocaleState] = useState<Locale>(initial);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback(
    (l: Locale) => {
      storeLocale(l);
      setLocaleState(l);
      onChange?.(l);
    },
    [onChange],
  );

  const value = useMemo<I18n>(() => {
    const dict = DICTS[locale];
    const t: T = (key, vars) => {
      let s = dict[key] ?? en[key] ?? key;
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
      return s;
    };
    const dateFmt = new Intl.DateTimeFormat(locale === 'ru' ? 'ru-RU' : 'en-GB', { dateStyle: 'medium' });
    const dateTimeFmt = new Intl.DateTimeFormat(locale === 'ru' ? 'ru-RU' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });
    let names: Intl.DisplayNames | null = null;
    try {
      names = new Intl.DisplayNames([locale], { type: 'language' });
    } catch {
      names = null;
    }
    return {
      locale,
      setLocale,
      t,
      formatDate: (iso, withTime = false) => {
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? '' : (withTime ? dateTimeFmt : dateFmt).format(d);
      },
      languageName: (code) => {
        const n = names?.of(code) ?? code;
        return n.charAt(0).toLocaleUpperCase(locale) + n.slice(1);
      },
    };
  }, [locale, setLocale]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error('I18nProvider missing');
  return v;
}

/** Count text: "1 person" / "5 people". */
export function countText(t: T, locale: Locale, n: number): string {
  const one = locale === 'en' ? n === 1 : false;
  return t(one ? 'dir.count.one' : 'dir.count.other', { n });
}
