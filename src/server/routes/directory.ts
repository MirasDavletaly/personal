import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { DirectoryDto, EmployeeDto, MeDto } from '../../shared/types.js';
import type { AppContext } from '../app.js';
import { one } from '../db.js';
import { notFound } from '../errors.js';
import { getEmployeeRow, listCompanies, listEmployeeRows, listTeams, toEmployeeDto } from '../models.js';
import { canSeeInactive, editableFields } from '../permissions.js';
import { isPhotoId, photoPath } from '../photos.js';
import { parseId } from '../validation.js';
import { sessionUserDto } from './auth.js';

export function registerDirectoryRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config } = ctx;

  app.get('/api/directory', async (): Promise<DirectoryDto> => ({
    companies: listCompanies(db),
    teams: listTeams(db),
    employees: listEmployeeRows(db, { includeInactive: false }).map(toEmployeeDto),
  }));

  app.get('/api/employees/:id', async (req): Promise<EmployeeDto> => {
    const id = parseId((req.params as { id: string }).id);
    const row = getEmployeeRow(db, id);
    if (!row || (row.status !== 'active' && !canSeeInactive(req.user!))) throw notFound();
    return toEmployeeDto(row);
  });

  app.get('/api/me', async (req): Promise<MeDto> => {
    const user = req.user!;
    const row = user.employeeId != null ? getEmployeeRow(db, user.employeeId) : undefined;
    return {
      user: sessionUserDto(user),
      employee: row ? toEmployeeDto(row) : null,
      editableFields: row ? editableFields(user, Number(row.id)) : [],
    };
  });

  // Photos are never served as static files: only through this route, with a
  // session, and only if the photo belongs to an employee the user may see.
  app.get('/api/photos/:file', async (req, reply) => {
    const m = /^([a-f0-9]{32})\.jpg$/.exec((req.params as { file: string }).file);
    if (!m || !isPhotoId(m[1]!)) throw notFound();
    const owner = one<{ status: string }>(db, 'SELECT status FROM employees WHERE photo_id = ?', m[1]!);
    if (!owner || (owner.status !== 'active' && !canSeeInactive(req.user!))) throw notFound();
    let data: Buffer;
    try {
      data = await readFile(photoPath(config.photosDir, m[1]!));
    } catch {
      throw notFound();
    }
    // The id changes whenever the photo is replaced, so the browser may keep it.
    reply.header('Cache-Control', 'private, max-age=86400, immutable');
    reply.header('Content-Disposition', 'inline');
    return reply.type('image/jpeg').send(data);
  });
}
