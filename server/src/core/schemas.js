import { z } from 'zod';

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Must be a valid id');
export const phone = z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10 digit mobile number');
export const email = z.string().trim().toLowerCase().email();
export const lat = z.number().min(-90).max(90);
export const lng = z.number().min(-180).max(180);
export const money = z.number().int().min(0).max(10000000);
export const date = z.coerce.date();

export const place = z.object({ address: z.string().trim().min(3).max(300), lat, lng });

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const searchQuery = pageQuery.extend({ search: z.string().trim().max(100).optional() });

/** PATCH version of a body: every field optional and defaults removed, so absent fields stay untouched. */
export function patchOf(schema) {
  const shape = Object.entries(schema.shape).map(([key, field]) => [key, (field instanceof z.ZodDefault ? field.unwrap() : field).optional()]);
  return z.object(Object.fromEntries(shape));
}
