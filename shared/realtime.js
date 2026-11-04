import { useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { API_ORIGIN } from './api.js';

/** Subscribes to server events for as long as the component is mounted. */
export function useRealtime(client, handlers, { bookingId } = {}) {
  const latest = useRef(handlers);
  latest.current = handlers;
  const token = client.session?.accessToken;

  useEffect(() => {
    if (!token) return undefined;
    const socket = io(API_ORIGIN, { auth: { token }, transports: ['websocket', 'polling'] });
    const join = () => { if (bookingId) socket.emit('booking:join', { bookingId }); };
    socket.on('connect', join);
    socket.onAny((event, payload) => latest.current[event]?.(payload));
    return () => socket.close();
  }, [token, bookingId]);
}
