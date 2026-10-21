// Demonstration data: loaded only on explicit request (CLI `demo-data --yes`,
// scripts/demo-data.sh). Fictional people, example.com addresses, marked
// is_demo = 1 and removable in one step. Never loaded automatically.
import { nowIso, one, run, tx, type DB } from './db.js';

interface DemoPerson {
  first: string;
  last: string;
  company: string;
  team: string;
  title: string;
  profession: string;
  work: string;
  languages: string[];
  email: boolean;
  phone: string | null;
  availability: 'yes' | 'partial' | 'no' | null;
}

const TEAMS: Record<string, string[]> = {
  Algoritmi: ['Architecture', 'Engineering', 'Project office'],
  'Green Spark': ['Finance', 'Legal', 'Energy projects'],
};

const PEOPLE: DemoPerson[] = [
  { first: 'Aruzhan', last: 'Demo', company: 'Algoritmi', team: 'Architecture', title: 'Lead architect', profession: 'Architect', work: 'Concept design of a demo office building', languages: ['kk', 'ru', 'en'], email: true, phone: '+7 700 000 0001', availability: 'yes' },
  { first: 'Daniyar', last: 'Sample', company: 'Algoritmi', team: 'Engineering', title: 'Structural engineer', profession: 'Engineer', work: 'Load calculations for the demo project', languages: ['ru', 'en'], email: true, phone: null, availability: 'partial' },
  { first: 'Giulia', last: 'Esempio', company: 'Algoritmi', team: 'Project office', title: 'Project manager', profession: 'Project manager', work: 'Coordination of the visit schedule', languages: ['it', 'en', 'fr'], email: true, phone: '+7 700 000 0003', availability: 'yes' },
  { first: 'Timur', last: 'Placeholder', company: 'Algoritmi', team: 'Engineering', title: 'MEP engineer', profession: 'Engineer', work: '', languages: ['ru', 'kk'], email: false, phone: '+7 700 000 0004', availability: null },
  { first: 'Saule', last: 'Example', company: 'Green Spark', team: 'Finance', title: 'Chief financial officer', profession: 'CFO', work: 'Annual budget for the demo year', languages: ['kk', 'ru', 'en', 'de'], email: true, phone: '+7 700 000 0005', availability: 'partial' },
  { first: 'Luca', last: 'Beispiel', company: 'Green Spark', team: 'Energy projects', title: 'Energy consultant', profession: 'Engineer', work: 'Feasibility study of a demo solar park', languages: ['de', 'it', 'en', 'rm'], email: true, phone: null, availability: 'yes' },
  { first: 'Madina', last: 'Test', company: 'Green Spark', team: 'Legal', title: 'Notary', profession: 'Notary', work: 'Document checks for demo contracts', languages: ['ru', 'kk'], email: true, phone: '+7 700 000 0007', availability: 'no' },
  { first: 'Arman', last: 'Fictional', company: 'Green Spark', team: 'Finance', title: 'Accountant', profession: 'Accountant', work: '', languages: [], email: false, phone: null, availability: null },
];

function translit(s: string): string {
  return s.toLowerCase().replace(/[^a-z]/g, '');
}

export function loadDemoData(db: DB): { employees: number; teams: number } {
  return tx(db, () => {
    const now = nowIso();
    let teams = 0;
    const companyIds = new Map<string, number>();
    for (const [company, teamNames] of Object.entries(TEAMS)) {
      let c = one<{ id: number }>(db, 'SELECT id FROM companies WHERE name = ? COLLATE NOCASE', company);
      if (!c) {
        const r = run(db, 'INSERT INTO companies (name, sort_order, active, created_at, updated_at) VALUES (?, 100, 1, ?, ?)', company, now, now);
        c = { id: r.lastInsertRowid };
      }
      companyIds.set(company, Number(c.id));
      teamNames.forEach((name, i) => {
        if (!one(db, 'SELECT 1 AS x FROM teams WHERE company_id = ? AND name = ? COLLATE NOCASE', c!.id, name)) {
          run(db, 'INSERT INTO teams (company_id, name, sort_order, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)', c!.id, name, (i + 1) * 10, now, now);
          teams++;
        }
      });
    }
    let employees = 0;
    for (const p of PEOPLE) {
      const companyId = companyIds.get(p.company)!;
      const team = one<{ id: number }>(db, 'SELECT id FROM teams WHERE company_id = ? AND name = ? COLLATE NOCASE', companyId, p.team);
      if (one(db, 'SELECT 1 AS x FROM employees WHERE is_demo = 1 AND first_name = ? AND last_name = ?', p.first, p.last)) continue;
      run(
        db,
        `INSERT INTO employees (first_name, last_name, company_id, team_id, official_title, profession, current_work, languages,
                                work_email, phone, algoritmi_availability, status, is_demo, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
        p.first,
        p.last,
        companyId,
        team ? Number(team.id) : null,
        p.title,
        p.profession,
        p.work,
        JSON.stringify(p.languages),
        p.email ? `${translit(p.first)}.${translit(p.last)}@example.com` : null,
        p.phone,
        p.availability,
        now,
        now,
      );
      employees++;
    }
    return { employees, teams };
  });
}

export function removeDemoData(db: DB): number {
  return tx(db, () => {
    run(db, "UPDATE users SET status = 'disabled' WHERE employee_id IN (SELECT id FROM employees WHERE is_demo = 1)");
    run(db, 'DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE employee_id IN (SELECT id FROM employees WHERE is_demo = 1))');
    return run(db, 'DELETE FROM employees WHERE is_demo = 1').changes;
  });
}

export function demoCount(db: DB): number {
  return Number(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM employees WHERE is_demo = 1')?.n ?? 0);
}
