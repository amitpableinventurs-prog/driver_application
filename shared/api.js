export const API_ORIGIN = import.meta.env.VITE_API_URL || 'http://localhost:5100';
const API_BASE = `${API_ORIGIN}/api/v1`;

export class ApiFailure extends Error {
  constructor(message, code, status, details) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** Fetch client with bearer auth and single-flight refresh-token rotation. */
export function createClient(storageKey) {
  let session = null;
  try { session = JSON.parse(localStorage.getItem(storageKey)); } catch { session = null; }
  let refreshing = null;
  const listeners = new Set();

  const save = (next) => {
    session = next;
    try {
      if (next) localStorage.setItem(storageKey, JSON.stringify(next));
      else localStorage.removeItem(storageKey);
    } catch { /* private mode: the session simply lasts for this tab */ }
    listeners.forEach((listener) => listener(next));
  };

  async function refresh() {
    refreshing ||= (async () => {
      const response = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: session?.refreshToken }),
      });
      if (!response.ok) { save(null); return false; }
      const { data } = await response.json();
      save({ ...session, accessToken: data.accessToken, refreshToken: data.refreshToken });
      return true;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  async function send(method, path, { body, form, raw } = {}, retried = false) {
    const headers = {};
    if (session?.accessToken) headers.Authorization = `Bearer ${session.accessToken}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetch(`${API_BASE}${path}`, { method, headers, body: form || (body !== undefined ? JSON.stringify(body) : undefined) });
    } catch {
      throw new ApiFailure('Could not reach the server. Check your connection.', 'NETWORK', 0);
    }
    if (response.status === 401 && session?.refreshToken && !retried && !path.startsWith('/auth/')) {
      if (await refresh()) return send(method, path, { body, form, raw }, true);
    }
    if (raw && response.ok) return response.blob();
    const json = await response.json().catch(() => null);
    if (!response.ok || !json?.success) {
      throw new ApiFailure(json?.error?.message || 'Something went wrong', json?.error?.code, response.status, json?.error?.details);
    }
    return json.data;
  }

  return {
    get session() { return session; },
    setSession: save,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    get: (path, params) => {
      const query = new URLSearchParams(Object.entries(params || {}).filter(([, value]) => value !== undefined && value !== ''));
      const suffix = query.size ? `?${query}` : '';
      return send('GET', `${path}${suffix}`);
    },
    post: (path, body = {}) => send('POST', path, { body }),
    put: (path, body) => send('PUT', path, { body }),
    patch: (path, body) => send('PATCH', path, { body }),
    del: (path, body) => send('DELETE', path, { body }),
    upload: (path, form) => send('POST', path, { form }),
    blob: (path) => send('GET', path, { raw: true }),
    async logout() {
      const refreshToken = session?.refreshToken;
      save(null);
      if (refreshToken) await fetch(`${API_BASE}/auth/logout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken }) }).catch(() => {});
    },
  };
}

export const assetUrl = (path) => (path?.startsWith('/') ? `${API_ORIGIN}${path}` : path);
