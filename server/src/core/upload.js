import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { badRequest } from './errors.js';

export const UPLOAD_ROOT = path.resolve(process.cwd(), 'uploads');
export const PUBLIC_DIR = path.join(UPLOAD_ROOT, 'public');
const PRIVATE_DIR = path.join(UPLOAD_ROOT, 'private');
fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.mkdirSync(PRIVATE_DIR, { recursive: true });

const TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' };

function uploader(dir, types) {
  return multer({
    storage: multer.diskStorage({
      destination: dir,
      filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${TYPES[file.mimetype]}`),
    }),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => {
      if (types.includes(file.mimetype)) cb(null, true);
      else cb(badRequest(`Only ${types.map((t) => t.split('/')[1]).join(', ')} files are allowed`, 'UNSUPPORTED_FILE'));
    },
  });
}

/** Avatars and banners: served publicly from /uploads/public. */
export const publicImage = uploader(PUBLIC_DIR, ['image/jpeg', 'image/png', 'image/webp']).single('file');
/** KYC documents: never served statically, only through an authenticated admin route. */
export const privateDocument = uploader(PRIVATE_DIR, Object.keys(TYPES)).single('file');

export const publicUrlFor = (file) => `/uploads/public/${file.filename}`;
export const privatePathFor = (filename) => path.join(PRIVATE_DIR, path.basename(filename));
