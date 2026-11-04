import { useState } from 'react';
import { Empty, ErrorBox, Field, Pager, Spinner, dateTime, rupees, useAction, useFetch, words } from '@shared/ui.jsx';
import { api, completePayment } from '../client.js';
import { useAccount } from '../account.js';

export default function Wallet() {
  const { reloadMe } = useAccount();
  const [page, setPage] = useState(1);
  const [amount, setAmount] = useState('500');
  const [run, busy] = useAction();
  const { data, loading, error, reload } = useFetch(() => api.get('/customer/wallet', { page }), [page]);

  const topUp = async (event) => {
    event.preventDefault();
    const done = await run(async () => {
      const order = await api.post('/customer/wallet/topup', { amount: Number(amount) });
      return completePayment(order);
    }, 'Money added to your wallet');
    if (done) { reload({ quiet: true }); reloadMe(); }
  };

  if (loading && !data) return <main className="page"><Spinner /></main>;
  if (error && !data) return <main className="page"><ErrorBox error={error} onRetry={reload} /></main>;

  return (
    <main className="page page-narrow">
      <div className="page-title"><h1>Wallet</h1></div>
      <div className="stack">
        <section className="balance"><span>Available balance</span><strong>{rupees(data.balance)}</strong></section>
        <form className="card stack" onSubmit={topUp}>
          <h2>Add money</h2>
          <div className="pick-tabs">
            {[200, 500, 1000, 2000].map((value) => (
              <button type="button" key={value} className="chip" aria-pressed={amount === String(value)} onClick={() => setAmount(String(value))}>{rupees(value)}</button>
            ))}
          </div>
          <Field label="Amount (₹)"><input type="number" min="10" max="50000" step="1" required value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <button className="btn btn-primary" disabled={busy}>Add {rupees(amount)}</button>
        </form>
        <section className="card">
          <h2 style={{ marginBottom: 6 }}>History</h2>
          {data.items.length === 0 ? <Empty title="No transactions yet" /> : data.items.map((tx) => (
            <div className="tx-row" key={tx._id}>
              <div><strong>{words(tx.category)}</strong><div className="muted small">{tx.note ? `${tx.note} · ` : ''}{dateTime(tx.createdAt)}</div></div>
              <span className={tx.direction === 'credit' ? 'tx-credit' : undefined}>{tx.direction === 'credit' ? '+' : '−'}{rupees(tx.amount)}</span>
            </div>
          ))}
          <Pager data={data} onPage={setPage} />
        </section>
      </div>
    </main>
  );
}
