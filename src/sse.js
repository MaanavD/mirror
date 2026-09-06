import { createLogger } from './logger.js';

/**
 * GET /api/events — pushes the whole state blob on every change.
 * The frontend treats this as an optimisation: if it drops, it polls every 60s.
 */
export function createEventStream({ store, heartbeatMs = 20_000, project = state => state, log = createLogger('sse') }) {
  const clients = new Set();

  const handler = (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // nginx / any buffering proxy in front of the tailnet host
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 5000\n\n');

    let blocked = false, pendingState = null;
    const pendingEvents = new Map();
    const write = frame => { blocked = res.write(frame) === false; };
    const send = state => {
      if (blocked) { pendingState = state; return; }
      write(`event: state\ndata: ${JSON.stringify(project(state, req))}\n\n`);
    };
    const sendEvent = (event, payload) => {
      if (blocked) { pendingEvents.set(event, payload); return; }
      write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    const drain = () => {
      blocked = false;
      if (pendingState) {
        const latest = pendingState;
        pendingState = null;
        send(latest);
      }
      for (const [event, payload] of pendingEvents) {
        if (blocked) break;
        pendingEvents.delete(event);
        sendEvent(event, payload);
      }
    };
    res.on?.('drain', drain);

    send(store.snapshot());
    const unsubscribe = store.subscribe(send);
    const heartbeat = setInterval(() => { if (!blocked) write(': ping\n\n'); }, heartbeatMs);
    heartbeat.unref?.();

    const client = { sendEvent, close: () => res.end() };
    clients.add(client);
    log.debug(`client connected (${clients.size} open)`);

    const cleanup = () => {
      clearInterval(heartbeat);
      res.removeListener?.('drain', drain);
      pendingState = null;
      pendingEvents.clear();
      unsubscribe();
      clients.delete(client);
      log.debug(`client gone (${clients.size} open)`);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
  };

  return {
    handler,
    get size() {
      return clients.size;
    },
    /** Push a one-off named event (not the state blob) to every open client. */
    broadcast(event, payload) {
      for (const client of clients) {
        try {
          client.sendEvent(event, payload);
        } catch {
          // dying socket: its close handler will reap it
        }
      }
    },
    closeAll() {
      for (const client of clients) {
        try {
          client.close();
        } catch {
          // already gone
        }
      }
      clients.clear();
    },
  };
}

export default createEventStream;
