import { created, ok, paginate } from '../core/api.js';
import { notFound } from '../core/errors.js';
import { pageQuery, patchOf } from '../core/schemas.js';
import { AuditLog } from '../models/index.js';

export function audit(req, action, entity, entityId, meta) {
  return AuditLog.create({
    admin: req.user._id,
    adminName: req.user.name,
    action,
    entity,
    entityId: entityId ? String(entityId) : undefined,
    meta,
    ip: req.ip,
  });
}

/** Standard list/create/update/delete endpoints for simple admin-managed collections. */
export function crud(api, path, Model, { perm, tag, entity, body, sort = { createdAt: -1 }, populate, deletable = true }) {
  api.get(path, { summary: `List ${entity}s`, tag, perm, query: pageQuery }, async (req, res) => {
    let query = Model.find().sort(sort);
    if (populate) query = query.populate(populate);
    ok(res, await paginate(query, req.q));
  });

  api.post(path, { summary: `Create ${entity}`, tag, perm, body }, async (req, res) => {
    const doc = await Model.create(req.body);
    await audit(req, 'create', entity, doc._id);
    created(res, doc);
  });

  api.patch(`${path}/:id`, { summary: `Update ${entity}`, tag, perm, body: patchOf(body) }, async (req, res) => {
    const doc = await Model.findByIdAndUpdate(req.params.id, req.body, { returnDocument: 'after', runValidators: true });
    if (!doc) throw notFound(`${entity} not found`);
    await audit(req, 'update', entity, doc._id, req.body);
    ok(res, doc);
  });

  if (deletable) {
    api.delete(`${path}/:id`, { summary: `Delete ${entity}`, tag, perm }, async (req, res) => {
      const doc = await Model.findByIdAndDelete(req.params.id);
      if (!doc) throw notFound(`${entity} not found`);
      await audit(req, 'delete', entity, doc._id);
      ok(res, { deleted: true });
    });
  }
}

/** Neutralises spreadsheet formula injection in exported user-entered text. */
export function csvCell(value) {
  let text = value === undefined || value === null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
