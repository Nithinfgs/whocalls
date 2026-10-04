import http from 'node:http';
import net from 'node:net';

/**
 * @typedef {object} Flow
 * @property {number} id
 * @property {'http'|'https'} scheme
 * @property {string} host
 * @property {number} port
 * @property {string} method
 * @property {string} [path]        only recorded for plain HTTP, never for tunnels
 * @property {string} [ip]          address the proxy actually connected to
 * @property {number} bytesUp
 * @property {number} bytesDown
 * @property {number} startedAt
 * @property {number} durationMs
 * @property {'ok'|'blocked'|'error'} outcome
 * @property {number} [status]
 * @property {string} [error]
 */

/**
 * @typedef {object} Upstream
 * @property {string} host
 * @property {number} port
 * @property {string} [auth]  "user:pass"
 */

/** Strip IPv6 brackets: "[::1]" -> "::1". */
function bare(host) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** Parse "host:port" as sent in a CONNECT request line. */
export function parseAuthority(authority) {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(authority);
  if (!m) return null;
  return { host: bare(m[1]).toLowerCase(), port: m[2] ? Number(m[2]) : 443 };
}

/**
 * Read an upstream proxy (corporate proxy) out of an environment, honouring NO_PROXY.
 * @param {NodeJS.ProcessEnv} env
 * @returns {(scheme: 'http'|'https', host: string) => Upstream | null}
 */
export function upstreamFromEnv(env) {
  const pick = (...names) => names.map((n) => env[n]).find((v) => v);
  const parse = (value) => {
    if (!value) return null;
    try {
      const u = new URL(value.includes('://') ? value : `http://${value}`);
      if (u.protocol !== 'http:') return null;
      const auth = u.username
        ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`
        : undefined;
      return { host: bare(u.hostname), port: Number(u.port || 80), auth };
    } catch {
      return null;
    }
  };
  const http_ = parse(pick('HTTP_PROXY', 'http_proxy'));
  const https_ = parse(pick('HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'));
  const noProxy = (pick('NO_PROXY', 'no_proxy') ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const excluded = (host) =>
    noProxy.some((p) => {
      if (p === '*') return true;
      const suffix = p.replace(/^\*?\./, '');
      return host === suffix || host.endsWith(`.${suffix}`);
    });
  return (scheme, host) => {
    if (excluded(host.toLowerCase())) return null;
    return scheme === 'https' ? https_ : http_;
  };
}

const HOP_BY_HOP = new Set([
  'connection',
  'proxy-connection',
  'proxy-authorization',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * A tiny forwarding proxy that records which hosts get contacted.
 * It never decrypts TLS: for HTTPS it only sees the CONNECT target and byte counts.
 *
 * @param {object} options
 * @param {(host: string, port: number) => boolean} [options.allow]  return false to refuse the connection
 * @param {(scheme: 'http'|'https', host: string) => Upstream | null} [options.upstream]
 * @param {(flow: Flow) => void} options.onFlow  called once per finished flow
 */
export function createProxy({ allow = () => true, upstream = () => null, onFlow }) {
  let nextId = 1;
  const sockets = new Set();
  /** @type {Set<() => void>} flows still running; flushed on close so a fast-exiting child never loses a row */
  const active = new Set();

  /** @param {Partial<Flow>} init */
  function begin(init) {
    const started = Date.now();
    /** @type {Flow} */
    const flow = {
      id: nextId++,
      scheme: 'https',
      host: '',
      port: 0,
      method: 'CONNECT',
      bytesUp: 0,
      bytesDown: 0,
      startedAt: started,
      durationMs: 0,
      outcome: 'ok',
      ...init,
    };
    let done = false;
    const flush = () => finish();
    active.add(flush);
    const finish = (patch = {}) => {
      if (done) return;
      done = true;
      active.delete(flush);
      Object.assign(flow, patch);
      flow.durationMs = Date.now() - started;
      onFlow(flow);
    };
    return { flow, finish };
  }

  const server = http.createServer((req, res) => {
    let target;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('whocalls: expected an absolute URL\n');
      return;
    }
    if (target.protocol !== 'http:') {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('whocalls: only http: and CONNECT are proxied\n');
      return;
    }
    const host = bare(target.hostname).toLowerCase();
    const port = Number(target.port || 80);
    const { flow, finish } = begin({
      scheme: 'http',
      host,
      port,
      method: req.method ?? 'GET',
      path: target.pathname,
    });

    if (!allow(host, port)) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end(`whocalls: ${host} is not on the allow list\n`);
      finish({ outcome: 'blocked', status: 403 });
      return;
    }

    const via = upstream('http', host);
    /** @type {import('node:http').OutgoingHttpHeaders} */
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k)) headers[k] = v;
    if (via?.auth) headers['proxy-authorization'] = `Basic ${Buffer.from(via.auth).toString('base64')}`;

    const out = http.request({
      host: via ? via.host : host,
      port: via ? via.port : port,
      path: via ? req.url : target.pathname + target.search,
      method: req.method,
      headers,
      agent: false,
    });
    out.on('socket', (s) => s.once('connect', () => (flow.ip = s.remoteAddress)));
    out.on('response', (pres) => {
      res.writeHead(pres.statusCode ?? 502, pres.headers);
      pres.on('data', (c) => (flow.bytesDown += c.length));
      pres.on('end', () => finish({ status: pres.statusCode }));
      pres.pipe(res);
    });
    out.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`whocalls: ${err.message}\n`);
      finish({ outcome: 'error', error: err.message });
    });
    req.on('data', (c) => (flow.bytesUp += c.length));
    req.on('aborted', () => out.destroy());
    req.pipe(out);
  });

  server.on('connection', (s) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  });

  server.on('connect', (req, client, head) => {
    const target = parseAuthority(req.url ?? '');
    client.on('error', () => {});
    if (!target) {
      client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    const { host, port } = target;
    const { flow, finish } = begin({ scheme: 'https', host, port });

    if (!allow(host, port)) {
      client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      finish({ outcome: 'blocked', status: 403 });
      return;
    }

    const via = upstream('https', host);
    const fail = (message) => {
      if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      finish({ outcome: 'error', error: message });
    };

    const tunnel = (remote, leftover) => {
      flow.ip = remote.remoteAddress;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) remote.write(head);
      if (leftover?.length) client.write(leftover);
      client.on('data', (c) => (flow.bytesUp += c.length));
      remote.on('data', (c) => (flow.bytesDown += c.length));
      client.pipe(remote);
      remote.pipe(client);
    };
    const wire = (remote) => {
      remote.on('error', (err) => {
        client.destroy();
        fail(err.message);
      });
      client.on('close', () => remote.destroy());
      remote.on('close', () => {
        client.destroy();
        finish({ status: 200 });
      });
    };

    if (!via) {
      const remote = net.connect(port, host, () => tunnel(remote));
      wire(remote);
      return;
    }

    // Chain through the user's own proxy.
    const authority = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
    const remote = net.connect(via.port, via.host, () => {
      const auth = via.auth ? `Proxy-Authorization: Basic ${Buffer.from(via.auth).toString('base64')}\r\n` : '';
      remote.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}\r\n`);
    });
    wire(remote);
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      remote.off('data', onData);
      const status = Number(/^HTTP\/1\.\d (\d{3})/.exec(buf.toString('latin1', 0, end))?.[1]);
      if (status === 200) tunnel(remote, buf.subarray(end + 4));
      else {
        remote.destroy();
        fail(`upstream proxy answered ${status || 'garbage'}`);
      }
    };
    remote.on('data', onData);
  });

  return {
    /** @returns {Promise<number>} the port that was bound on 127.0.0.1 */
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(/** @type {net.AddressInfo} */ (server.address()).port));
      });
    },
    close() {
      return new Promise((resolve) => {
        for (const f of [...active]) f();
        for (const s of sockets) s.destroy();
        server.close(() => resolve(undefined));
      });
    },
  };
}
