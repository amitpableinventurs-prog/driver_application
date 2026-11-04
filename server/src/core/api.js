import { Router } from 'express';
import { badRequest } from './errors.js';
import { requireAuth, requirePermission } from './auth.js';

/** Every route is registered here, so the OpenAPI spec, Postman collection and API.md always match the code. */
export const registry = [];

const OBJECT_ID = /^[a-f\d]{24}$/i;

function validate({ body, query }) {
  return (req, _res, next) => {
    for (const [name, value] of Object.entries(req.params)) {
      if (/id$/i.test(name) && !OBJECT_ID.test(value)) throw badRequest(`${name} is not a valid id`, 'INVALID_ID');
    }
    const parse = (schema, input, where) => {
      const result = schema.safeParse(input ?? {});
      if (result.success) return result.data;
      const details = result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
      const first = details[0];
      throw badRequest(first.field ? `${first.field}: ${first.message}` : first.message, 'VALIDATION_ERROR', { where, issues: details });
    };
    req.body = body ? parse(body, req.body, 'body') : req.body;
    req.q = query ? parse(query, req.query, 'query') : {};
    next();
  };
}

export function createApi({ prefix, tag, auth = null }) {
  const router = Router();
  const add = (method) => (path, meta, handler) => {
    const routeAuth = meta.auth === undefined ? auth : meta.auth;
    registry.push({ ...meta, method, path: `${prefix}${path === '/' ? '' : path}`, tag: meta.tag || tag, auth: routeAuth });
    const chain = [];
    if (routeAuth) chain.push(requireAuth(routeAuth));
    if (meta.perm) chain.push(requirePermission(meta.perm));
    if (meta.upload) chain.push(meta.upload);
    chain.push(validate(meta), handler);
    router[method](path, ...chain);
  };
  return { router, prefix, get: add('get'), post: add('post'), put: add('put'), patch: add('patch'), delete: add('delete') };
}

export const ok = (res, data, message) => res.json({ success: true, message, data });
export const created = (res, data, message) => res.status(201).json({ success: true, message, data });

export async function paginate(query, { page = 1, limit = 20 }) {
  const total = await query.model.countDocuments(query.getFilter());
  const items = await query.skip((page - 1) * limit).limit(limit);
  return { items, page, limit, total, pages: Math.ceil(total / limit) };
}

export const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
