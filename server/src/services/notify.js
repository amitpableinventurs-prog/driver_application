import { Notification, Customer, Driver } from '../models/index.js';
import { emitTo, rooms } from './realtime.js';

const MODELS = { customer: Customer, driver: Driver };

/**
 * Push delivery hook. Device tokens are already stored per account, so wiring Firebase means
 * replacing the body of this function with a firebase-admin sendEachForMulticast call.
 */
export async function sendPush(role, id, { title, body, data }) {
  const account = await MODELS[role].findById(id).select('deviceTokens');
  if (!account?.deviceTokens?.length) return;
  if (process.env.PUSH_DEBUG === 'true') console.log(`[push:${role}:${id}] ${title} - ${body}`, data || '');
}

/** Notification failures must never break the money or booking flow that triggered them. */
export async function notify(role, id, { title, body, type = 'general', data }) {
  try {
    const notification = await Notification.create({ role, recipient: id, title, body, type, data });
    emitTo(rooms[role](id), 'notification', notification);
    await sendPush(role, id, { title, body, data });
    return notification;
  } catch (err) {
    console.error('[notify] failed', err.message);
    return null;
  }
}
