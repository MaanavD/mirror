import { createLogger } from './logger.js';

/**
 * GET /api/events — pushes the whole state blob on every change.
 * The frontend treats this as an optimisation: if it drops, it polls every 60s.
 */
export function createEventStream({ store, heartbeatMs = 20_000, log = createLogger('sse') }) {
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

    const send = (state) => {
      res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
    };

    send(store.snapshot());
    const unsubscribe = store.subscribe(send);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), heartbeatMs);
    heartbeat.unref?.();

    const client = { res, close: () => res.end() };
    clients.add(client);
    log.debug(`client connected (${clients.size} open)`);

    const cleanup = () => {
      clearInterval(heartbeat);
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
      const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
      for (const client of clients) {
        try {
          client.res.write(frame);
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
