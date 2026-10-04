import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createProxy, parseAuthority, upstreamFromEnv } from '../src/proxy.js';
import { httpServer, viaProxy } from './helpers.js';

async function withProxy(options, fn) {
  const flows = [];
  const proxy = createProxy({ onFlow: (f) => flows.push(f), ...options });
  const port = await proxy.listen();
  try {
    await fn(port, flows);
  } finally {
    await proxy.close();
  }
}

test('parseAuthority handles hosts, ports and IPv6', () => {
  assert.deepEqual(parseAuthority('Example.com:8443'), { host: 'example.com', port: 8443 });
  assert.deepEqual(parseAuthority('example.com'), { host: 'example.com', port: 443 });
  assert.deepEqual(parseAuthority('[::1]:9000'), { host: '::1', port: 9000 });
  assert.equal(parseAuthority(''), null);
});

test('forwards plain HTTP and records host, path and bytes', async () => {
  const origin = await httpServer('hello world');
  await withProxy({}, async (port, flows) => {
    const res = await viaProxy(port, { target: `http://127.0.0.1:${origin.port}/some/path?q=secret` });
    assert.equal(res.status, 200);
    assert.equal(res.body, 'hello world');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(flows.length, 1);
    assert.equal(flows[0].host, '127.0.0.1');
    assert.equal(flows[0].scheme, 'http');
    assert.equal(flows[0].path, '/some/path', 'query strings must not be recorded');
    assert.equal(flows[0].bytesDown, 11);
    assert.equal(flows[0].outcome, 'ok');
  });
  await origin.close();
});

test('tunnels CONNECT without reading the payload', async () => {
  const echo = net.createServer((s) => s.on('data', (d) => s.write(d)));
  await new Promise((r) => echo.listen(0, '127.0.0.1', () => r(undefined)));
  const echoPort = /** @type {net.AddressInfo} */ (echo.address()).port;
  await withProxy({}, async (port, flows) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: `127.0.0.1:${echoPort}` });
    const socket = await new Promise((resolve, reject) => {
      req.on('connect', (res, s) => (res.statusCode === 200 ? resolve(s) : reject(new Error(`status ${res.statusCode}`))));
      req.on('error', reject);
      req.end();
    });
    const reply = await new Promise((resolve) => {
      socket.once('data', resolve);
      socket.write('ping');
    });
    assert.equal(String(reply), 'ping');
    socket.destroy();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(flows.length, 1);
    assert.equal(flows[0].scheme, 'https');
    assert.equal(flows[0].port, echoPort);
    assert.equal(flows[0].bytesUp, 4);
    assert.equal(flows[0].bytesDown, 4);
  });
  echo.close();
});

test('refuses blocked hosts with 403 and records them', async () => {
  const origin = await httpServer();
  await withProxy({ allow: () => false }, async (port, flows) => {
    const res = await viaProxy(port, { target: `http://127.0.0.1:${origin.port}/` });
    assert.equal(res.status, 403);
    assert.equal(origin.hits.length, 0, 'origin must never be contacted');
    assert.equal(flows[0].outcome, 'blocked');
  });
  await origin.close();
});

test('reports a failed upstream as 502', async () => {
  await withProxy({}, async (port, flows) => {
    const res = await viaProxy(port, { target: 'http://127.0.0.1:1/' });
    assert.equal(res.status, 502);
    assert.equal(flows[0].outcome, 'error');
  });
});

test('chains through an upstream proxy', async () => {
  const origin = await httpServer('via upstream');
  await withProxy({}, async (upstreamPort, upstreamFlows) => {
    const upstream = () => ({ host: '127.0.0.1', port: upstreamPort });
    await withProxy({ upstream }, async (port, flows) => {
      const res = await viaProxy(port, { target: `http://127.0.0.1:${origin.port}/x` });
      assert.equal(res.body, 'via upstream');
      assert.equal(flows.length, 1);
      assert.equal(upstreamFlows.length, 1, 'request must have gone through the upstream proxy');
    });
  });
  await origin.close();
});

test('upstreamFromEnv honours NO_PROXY', () => {
  const pick = upstreamFromEnv({ HTTPS_PROXY: 'http://user:pw@corp:3128', NO_PROXY: 'internal.example, .local' });
  assert.deepEqual(pick('https', 'registry.npmjs.org'), { host: 'corp', port: 3128, auth: 'user:pw' });
  assert.equal(pick('https', 'internal.example'), null);
  assert.equal(pick('https', 'a.internal.example'), null);
  assert.equal(pick('https', 'box.local'), null);
  assert.equal(pick('http', 'example.com'), null, 'no HTTP_PROXY configured');
});
