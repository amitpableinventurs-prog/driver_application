import { Setting } from '../models/index.js';

export function getSettings() {
  return Setting.findOneAndUpdate(
    { key: 'global' },
    { $setOnInsert: { key: 'global' } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );
}
