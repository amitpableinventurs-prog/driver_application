import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Inbox, LoaderCircle, TriangleAlert, X } from 'lucide-react';

/* ------------------------------ formatting ------------------------------ */

export const rupees = (value) => `₹${Number(value || 0).toLocaleString('en-IN')}`;
export const dateTime = (value) => (value ? new Date(value).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
export const dateOnly = (value) => (value ? new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
export const words = (value) => {
  const text = String(value ?? '').replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

const TONES = {
  good: ['active', 'approved', 'completed', 'paid', 'resolved', 'online'],
  warn: ['pending', 'submitted', 'searching', 'requested', 'open', 'in_progress', 'accepted', 'arrived', 'unpaid'],
  bad: ['blocked', 'suspended', 'rejected', 'cancelled', 'no_driver', 'failed', 'disabled', 'deleted'],
};

export function Badge({ value, label }) {
  const tone = Object.keys(TONES).find((key) => TONES[key].includes(value)) || 'plain';
  return <span className={`badge badge-${tone}`}>{label || words(value)}</span>;
}

/* ------------------------------ feedback ------------------------------ */

export const Spinner = ({ label = 'Loading' }) => (
  <div className="state" role="status"><LoaderCircle className="spin" size={22} aria-hidden /> <span>{label}</span></div>
);

export const Empty = ({ title = 'Nothing here yet', hint, children }) => (
  <div className="state state-empty">
    <Inbox size={28} aria-hidden />
    <strong>{title}</strong>
    {hint && <p>{hint}</p>}
    {children}
  </div>
);

export const ErrorBox = ({ error, onRetry }) => (
  <div className="state state-error" role="alert">
    <TriangleAlert size={24} aria-hidden />
    <strong>{error?.message || 'Something went wrong'}</strong>
    {onRetry && <button className="btn" onClick={onRetry}>Try again</button>}
  </div>
);

const ToastContext = createContext(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((message, tone = 'good') => {
    const id = crypto.randomUUID();
    setToasts((list) => [...list, { id, message, tone }]);
    setTimeout(() => setToasts((list) => list.filter((toast) => toast.id !== id)), 4200);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((toast) => <div key={toast.id} className={`toast toast-${toast.tone}`}>{toast.message}</div>)}
      </div>
    </ToastContext.Provider>
  );
}

/** Wraps a mutation: disables while running, shows success and failure toasts. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (action, success) => {
    setBusy(true);
    try {
      const result = await action();
      if (success) toast(success);
      return result ?? true;
    } catch (error) {
      toast(error.message, 'bad');
      return null;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  return [run, busy];
}

/* ------------------------------ data ------------------------------ */

export function useFetch(loader, deps = []) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const latest = useRef(0);
  const reload = useCallback(async ({ quiet = false } = {}) => {
    const ticket = ++latest.current;
    if (!quiet) setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const data = await loader();
      if (ticket === latest.current) setState({ data, loading: false, error: null });
    } catch (error) {
      if (ticket === latest.current) setState((current) => ({ ...current, loading: false, error }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { reload(); }, [reload]);
  return { ...state, reload };
}

export function useDebounced(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** Paginated list with filters; any filter change returns to page 1. */
export function useList(fetchPage, initialFilters = {}) {
  const [filters, setFilters] = useState(initialFilters);
  const [page, setPage] = useState(1);
  const debounced = useDebounced(filters);
  const key = JSON.stringify(debounced);
  const result = useFetch(() => fetchPage({ page, limit: 20, ...debounced }), [page, key]);
  const setFilter = useCallback((name, value) => {
    setFilters((current) => ({ ...current, [name]: value }));
    setPage(1);
  }, []);
  return { ...result, filters, setFilter, page, setPage };
}

/* ------------------------------ layout pieces ------------------------------ */

export function Pager({ data, onPage }) {
  if (!data || data.pages <= 1) return null;
  return (
    <nav className="pager" aria-label="Pagination">
      <span>{data.total.toLocaleString('en-IN')} total</span>
      <button className="btn btn-icon" disabled={data.page <= 1} onClick={() => onPage(data.page - 1)} aria-label="Previous page"><ChevronLeft size={16} /></button>
      <span>Page {data.page} of {data.pages}</span>
      <button className="btn btn-icon" disabled={data.page >= data.pages} onClick={() => onPage(data.page + 1)} aria-label="Next page"><ChevronRight size={16} /></button>
    </nav>
  );
}

export function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="btn btn-icon btn-ghost" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export const Field = ({ label, hint, children }) => (
  <label className="field">
    <span className="field-label">{label}</span>
    {children}
    {hint && <span className="field-hint">{hint}</span>}
  </label>
);

/** Dialog asking for a required note before a consequential action. */
export function PromptModal({ title, label, confirmLabel = 'Confirm', danger, onSubmit, onClose, placeholder, optional }) {
  const [text, setText] = useState('');
  const [run, busy] = useAction();
  const submit = async (event) => {
    event.preventDefault();
    if (await run(() => onSubmit(text.trim()))) onClose();
  };
  return (
    <Modal title={title} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label={label}>
          <textarea rows={3} value={text} onChange={(event) => setText(event.target.value)} placeholder={placeholder} required={!optional} minLength={optional ? undefined : 3} autoFocus />
        </Field>
        <div className="row-end">
          <button type="button" className="btn" onClick={onClose}>Back</button>
          <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={busy}>{confirmLabel}</button>
        </div>
      </form>
    </Modal>
  );
}

export function DataTable({ columns, rows, onRowClick, rowKey = '_id' }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr>{columns.map((column) => <th key={column.label} className={column.align === 'right' ? 'num' : undefined}>{column.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row[rowKey]} className={onRowClick ? 'clickable' : undefined} onClick={onRowClick ? () => onRowClick(row) : undefined}>
              {columns.map((column) => (
                <td key={column.label} className={column.align === 'right' ? 'num' : undefined}>{column.render ? column.render(row) : row[column.key] ?? '—'}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FareLines({ fare }) {
  const lines = useMemo(() => [
    ['Base fare', fare?.base],
    ['Extra time', fare?.extraTime],
    ['Extra distance', fare?.extraDistance],
    ['Allowances', fare?.allowances],
    ['Night charge', fare?.nightCharge],
    ['Discount', fare?.discount ? -fare.discount : 0],
    ['Tax', fare?.tax],
    ['Tolls and parking', fare?.extraCharges],
  ].filter(([, value]) => value), [fare]);
  if (!fare) return null;
  return (
    <dl className="fare">
      {lines.map(([label, value]) => (
        <div key={label}><dt>{label}</dt><dd>{value < 0 ? `−${rupees(-value)}` : rupees(value)}</dd></div>
      ))}
      <div className="fare-total"><dt>Total</dt><dd>{rupees(fare.total)}</dd></div>
    </dl>
  );
}
