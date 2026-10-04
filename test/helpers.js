import http from 'node:http';
import os from 'node:os';

/** A local HTTP server that answers every request with a fixed body. */
export async function httpServer(body = 'hello', host = '127.0.0.1') {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    res.end(body);
  });
  await new Promise((r) => server.listen(0, host, () => r(undefined)));
  return { port: /** @type {import('node:net').AddressInfo} */ (server.address()).port, hits, close: () => new Promise((r) => (server.closeAllConnections(), server.close(() => r(undefined)))) };
}

/** First non-loopback IPv4 address of this machine, or null (e.g. in a sealed sandbox). */
export function lanAddress() {
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) return i.address;
  return null;
}

/** Send one request through a proxy with CONNECT or absolute-URI form. */
export function viaProxy(proxyPort, { method = 'GET', target }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method, path: target, headers: { host: target } });
    req.on('response', (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}
