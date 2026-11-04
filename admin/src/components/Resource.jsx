import { useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { DataTable, Empty, ErrorBox, Field, Modal, Pager, Spinner, useAction, useList, words } from '@shared/ui.jsx';
import { api } from '../client.js';

const toInputDate = (value) => (value ? new Date(value).toISOString().slice(0, 10) : '');

function initialValues(fields, row) {
  return Object.fromEntries(fields.map((field) => {
    const raw = row ? (field.read ? field.read(row) : row[field.name]) : field.default;
    if (field.type === 'date') return [field.name, toInputDate(raw)];
    if (field.type === 'checkbox') return [field.name, raw ?? true];
    return [field.name, raw ?? ''];
  }));
}

function cleanValues(fields, values) {
  const output = {};
  for (const field of fields) {
    const value = values[field.name];
    if (field.type === 'number') {
      if (value !== '') output[field.name] = Number(value);
    } else if (field.type === 'date') {
      if (value) output[field.name] = new Date(field.endOfDay ? `${value}T23:59:59+05:30` : `${value}T00:00:00+05:30`).toISOString();
    } else if (field.type === 'checkbox' || value !== '') {
      output[field.name] = value;
    }
  }
  return output;
}

function ResourceForm({ title, fields, row, onSubmit, onClose }) {
  const [values, setValues] = useState(() => initialValues(fields, row));
  const [run, busy] = useAction();
  const set = (name, value) => setValues((current) => ({ ...current, [name]: value }));
  const submit = async (event) => {
    event.preventDefault();
    if (await run(() => onSubmit(cleanValues(fields, values)), 'Saved')) onClose();
  };
  return (
    <Modal title={title} onClose={onClose} wide={fields.length > 6}>
      <form className="stack" onSubmit={submit}>
        <div className="form-grid">
          {fields.filter((field) => !field.when || field.when(values)).map((field) => {
            const common = { value: values[field.name], required: field.required, onChange: (e) => set(field.name, e.target.value) };
            if (field.type === 'checkbox') {
              return (
                <label className="check" key={field.name}>
                  <input type="checkbox" checked={Boolean(values[field.name])} onChange={(e) => set(field.name, e.target.checked)} /> {field.label}
                </label>
              );
            }
            return (
              <div key={field.name} className={field.type === 'textarea' ? 'span-2' : undefined}>
                <Field label={field.label} hint={field.hint}>
                  {field.type === 'select' ? (
                    <select {...common}>
                      {!field.required && <option value="">None</option>}
                      {field.required && !values[field.name] && <option value="">Select</option>}
                      {field.options.map((option) => <option key={option.value ?? option} value={option.value ?? option}>{option.label ?? words(option)}</option>)}
                    </select>
                  ) : field.type === 'textarea' ? <textarea rows={field.rows || 6} {...common} />
                    : <input type={field.type || 'text'} step={field.step} min={field.min} {...common} />}
                </Field>
              </div>
            );
          })}
        </div>
        <div className="row-end">
          <button type="button" className="btn" onClick={onClose}>Back</button>
          <button className="btn btn-primary" disabled={busy}>Save</button>
        </div>
      </form>
    </Modal>
  );
}

/** Generic list and edit screen for the simple admin collections. */
export function Resource({ title, subtitle, path, singular, columns, fields, deletable = true, emptyHint }) {
  const list = useList((query) => api.get(path, query));
  const [editing, setEditing] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [run, busy] = useAction();

  const save = async (values) => {
    if (editing === 'new') await api.post(path, values);
    else await api.patch(`${path}/${editing._id}`, values);
    await list.reload({ quiet: true });
    return true;
  };
  const remove = async () => {
    if (await run(() => api.del(`${path}/${confirming._id}`), `${singular} deleted`)) {
      setConfirming(null);
      list.reload({ quiet: true });
    }
  };

  const actions = {
    label: 'Actions',
    render: (row) => (
      <div className="row">
        <button className="btn btn-icon" onClick={() => setEditing(row)} aria-label="Edit"><Pencil size={15} /></button>
        {deletable && <button className="btn btn-icon" onClick={() => setConfirming(row)} aria-label="Delete"><Trash2 size={15} /></button>}
      </div>
    ),
  };

  return (
    <>
      <div className="page-head">
        <div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
        <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={16} aria-hidden /> Add {singular.toLowerCase()}</button>
      </div>
      <section className="card card-flush">
        {list.error ? <ErrorBox error={list.error} onRetry={list.reload} />
          : list.loading && !list.data ? <Spinner />
            : !list.data.items.length ? <Empty title={`No ${title.toLowerCase()} yet`} hint={emptyHint} />
              : <DataTable columns={[...columns, actions]} rows={list.data.items} />}
        <Pager data={list.data} onPage={list.setPage} />
      </section>
      {editing && (
        <ResourceForm
          title={editing === 'new' ? `Add ${singular.toLowerCase()}` : `Edit ${singular.toLowerCase()}`}
          fields={fields}
          row={editing === 'new' ? null : editing}
          onSubmit={save}
          onClose={() => setEditing(null)}
        />
      )}
      {confirming && (
        <Modal title={`Delete ${singular.toLowerCase()}?`} onClose={() => setConfirming(null)}>
          <div className="stack">
            <p>This cannot be undone.</p>
            <div className="row-end">
              <button className="btn" onClick={() => setConfirming(null)}>Back</button>
              <button className="btn btn-danger" disabled={busy} onClick={remove}>Delete</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
