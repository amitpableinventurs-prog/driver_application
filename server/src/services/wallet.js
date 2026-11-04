import { badRequest } from '../core/errors.js';
import { Customer, Driver, Transaction } from '../models/index.js';

const MODELS = { customer: Customer, driver: Driver };

async function recordEntry(entry) {
  try {
    return await Transaction.create(entry);
  } catch (err) {
    if (err.code === 11000) return null; // same idempotency key: this movement already happened
    throw err;
  }
}

/** Credits a wallet once per key. Returns the ledger entry, or null if the key was already applied. */
export async function credit({ role, ownerId, amount, category, key, booking, note }) {
  if (amount <= 0) return null;
  const tx = await recordEntry({ ownerRole: role, owner: ownerId, direction: 'credit', amount, category, booking, note, idempotencyKey: key });
  if (!tx) return null;
  const owner = await MODELS[role].findByIdAndUpdate(ownerId, { $inc: { walletBalance: amount } }, { returnDocument: 'after' });
  tx.balanceAfter = owner.walletBalance;
  await tx.save();
  return tx;
}

/** Debits a wallet once per key. Throws INSUFFICIENT_BALANCE unless allowNegative is set. */
export async function debit({ role, ownerId, amount, category, key, booking, note, allowNegative = false }) {
  if (amount <= 0) return null;
  const tx = await recordEntry({ ownerRole: role, owner: ownerId, direction: 'debit', amount, category, booking, note, idempotencyKey: key });
  if (!tx) return null;
  const filter = allowNegative ? { _id: ownerId } : { _id: ownerId, walletBalance: { $gte: amount } };
  const owner = await MODELS[role].findOneAndUpdate(filter, { $inc: { walletBalance: -amount } }, { returnDocument: 'after' });
  if (!owner) {
    await Transaction.deleteOne({ _id: tx._id });
    throw badRequest('Insufficient wallet balance', 'INSUFFICIENT_BALANCE');
  }
  tx.balanceAfter = owner.walletBalance;
  await tx.save();
  return tx;
}
