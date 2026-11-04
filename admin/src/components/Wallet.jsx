import { useState } from 'react';
import { DataTable, Empty, Field, Modal, dateTime, rupees, useAction, words } from '@shared/ui.jsx';
import { api } from '../client.js';

export function WalletModal({ path, name, onClose, onDone }) {
  const [form, setForm] = useState({ direction: 'credit', amount: '', note: '' });
  const [run, busy] = useAction();
  const submit = async (event) => {
    event.preventDefault();
    const done = await run(() => api.post(path, { ...form, amount: Number(form.amount) }), 'Wallet updated');
    if (done) { onDone(); onClose(); }
  };
  return (
    <Modal title={`Adjust wallet${name ? ` for ${name}` : ''}`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Action">
          <select value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })}>
            <option value="credit">Add money</option>
            <option value="debit">Deduct money</option>
          </select>
        </Field>
        <Field label="Amount (₹)"><input type="number" min="1" step="1" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>
        <Field label="Reason" hint="Recorded in the audit log and shown in the wallet history"><input required minLength={3} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
        <div className="row-end">
          <button type="button" className="btn" onClick={onClose}>Back</button>
          <button className="btn btn-primary" disabled={busy}>Save</button>
        </div>
      </form>
    </Modal>
  );
}

export const signed = (tx) => `${tx.direction === 'credit' ? '+' : '−'}${rupees(tx.amount)}`;

export function TransactionsCard({ transactions }) {
  return (
    <section className="card card-flush">
      <div className="card-head" style={{ padding: '16px 18px 0' }}><h2>Wallet history</h2></div>
      {transactions.length === 0 ? <Empty title="No transactions yet" /> : (
        <DataTable
          rows={transactions}
          columns={[
            { label: 'When', render: (t) => dateTime(t.createdAt) },
            { label: 'Type', render: (t) => words(t.category) },
            { label: 'Note', render: (t) => t.note || '—' },
            { label: 'Amount', align: 'right', render: signed },
            { label: 'Balance', align: 'right', render: (t) => rupees(t.balanceAfter) },
          ]}
        />
      )}
    </section>
  );
}
