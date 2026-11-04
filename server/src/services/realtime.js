import { Server } from 'socket.io';
import { env } from '../config/env.js';
import { authenticate } from '../core/auth.js';
import { Booking, Driver, ACTIVE_STATUSES } from '../models/index.js';

let io = null;

export const rooms = {
  customer: (id) => `customer:${id}`,
  driver: (id) => `driver:${id}`,
  booking: (id) => `booking:${id}`,
  admins: 'admins',
};

export function emitTo(room, event, payload) {
  io?.to(room).emit(event, payload);
}

export async function updateDriverLocation(driver, { lat, lng, heading }) {
  const updated = await Driver.findByIdAndUpdate(driver._id, {
    location: { type: 'Point', coordinates: [lng, lat] },
    heading,
    locationUpdatedAt: new Date(),
  }, { returnDocument: 'after' });
  const payload = { driverId: String(driver._id), lat, lng, heading, at: updated.locationUpdatedAt };
  if (updated.activeBooking) emitTo(rooms.booking(updated.activeBooking), 'driver:location', payload);
  emitTo(rooms.admins, 'driver:location', { ...payload, name: updated.name, isOnline: updated.isOnline });
  return updated;
}

async function canJoinBooking(role, account, bookingId) {
  if (role === 'admin') return true;
  const owner = role === 'customer' ? { customer: account._id } : { driver: account._id };
  return Boolean(await Booking.exists({ _id: bookingId, ...owner, status: { $in: ACTIVE_STATUSES } }));
}

export function initRealtime(httpServer) {
  io = new Server(httpServer, { cors: { origin: env.corsOrigins, credentials: true } });

  io.use(async (socket, next) => {
    try {
      const session = await authenticate(socket.handshake.auth?.token || '');
      socket.data.role = session.role;
      socket.data.account = session.account;
      next();
    } catch (err) {
      next(new Error(err.code || 'UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket) => {
    const { role, account } = socket.data;
    socket.join(role === 'admin' ? rooms.admins : rooms[role](account._id));

    socket.on('booking:join', async ({ bookingId } = {}, ack) => {
      try {
        const allowed = /^[a-f\d]{24}$/i.test(bookingId || '') && await canJoinBooking(role, account, bookingId);
        if (allowed) socket.join(rooms.booking(bookingId));
        ack?.({ ok: allowed });
      } catch {
        ack?.({ ok: false });
      }
    });

    socket.on('booking:leave', ({ bookingId } = {}) => socket.leave(rooms.booking(bookingId)));

    socket.on('driver:location', async ({ lat, lng, heading } = {}, ack) => {
      const valid = role === 'driver' && Number.isFinite(lat) && Number.isFinite(lng)
        && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
      if (!valid) return ack?.({ ok: false });
      try {
        await updateDriverLocation(account, { lat, lng, heading });
        ack?.({ ok: true });
      } catch {
        ack?.({ ok: false });
      }
    });
  });

  return io;
}

export async function closeRealtime() {
  if (io) await io.close();
  io = null;
}
