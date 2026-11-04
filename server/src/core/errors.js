export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, code = 'BAD_REQUEST', details) => new ApiError(400, code, message, details);
export const unauthorized = (message = 'Authentication required', code = 'UNAUTHORIZED') => new ApiError(401, code, message);
export const forbidden = (message = 'You do not have access to this resource', code = 'FORBIDDEN') => new ApiError(403, code, message);
export const notFound = (message = 'Not found', code = 'NOT_FOUND') => new ApiError(404, code, message);
export const conflict = (message, code = 'CONFLICT') => new ApiError(409, code, message);

export function errorHandler(err, req, res, _next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ success: false, error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err.name === 'MulterError') {
    return res.status(400).json({ success: false, error: { code: 'UPLOAD_ERROR', message: err.message } });
  }
  if (err.code === 11000) {
    return res.status(409).json({ success: false, error: { code: 'DUPLICATE', message: 'This record already exists', details: err.keyValue } });
  }
  if (err.name === 'ValidationError' || err.name === 'CastError') {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.message } });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
  }
  console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
}
