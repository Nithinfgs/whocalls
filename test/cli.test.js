import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { httpServer, lanAddress } from './helpers.js';
import { lsofAvailable } from '../src/sampler.js';

const bin = fileURLToPath(new URL('../bin/whocalls.js', import.meta.url));
const run = (args, opts = {}) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', ...opts });
// Talks to the proxy explicitly with a private Agent, so the result does not depend on whether this Node honours NODE_USE_ENV_PROXY.
const fetcher = (url) => `const u=new URL(${JSON.stringify(url)});const h=require('http');h.get({agent:new h.Agent(),host:'127.0.0.1',port:process.env.HTTP_PROXY.split(':').pop(),path:u.href,headers:{host:u.host}},r=>{r.resume();r.on('end',()=>process.exit(0))})`;

test('--version and --help', () => {
  assert.match(run(['--version']).stdout, /^\d+\.\d+\.\d+/);
  assert.match(run(['--help']).stdout, /Usage/);
  assert.equal(run([]).status, 2);
});

test('reports the hosts a real child process contacts, as JSON', async (t) => {
  const origin = await httpServer();
  t.after(() => origin.close());
  const out = await new Promise((resolve) => {
    import('node:child_process').then(({ execFile }) =>
      execFile(process.execPath, [bin, '--json', '--include-local', '--no-sample', '--', process.execPath, '-e', fetcher(`http://127.0.0.1:${origin.port}/x`)], (err, stdout) => resolve({ code: err?.code ?? 0, stdout })),
    );
  });
  assert.equal(out.code, 0);
  const json = JSON.parse(out.stdout);
  assert.equal(json.hosts[0].host, '127.0.0.1');
  assert.equal(json.hosts[0].plainHttp, true);
  assert.equal(json.exitCode, 0);
});

test('child exit status is passed through', () => {
  const r = run(['--no-sample', '--', process.execPath, '-e', 'process.exit(7)']);
  assert.equal(r.status, 7);
});

test('missing command exits 127', () => {
  const r = run(['--no-sample', '--', 'definitely-not-a-real-binary-xyz']);
  assert.equal(r.status, 127);
  assert.match(r.stderr, /could not run/);
});

test('allow list: violation exits 3, --enforce blocks the request', async (t) => {
  const origin = await httpServer();
  t.after(() => origin.close());
  const args = (extra) => ['--no-sample', '--include-local', ...extra, '--', process.execPath, '-e', fetcher(`http://127.0.0.1:${origin.port}/`)];
  const { execFile } = await import('node:child_process');
  const go = (a) => new Promise((resolve) => execFile(process.execPath, [bin, ...a], (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stderr })));

  const ok = await go(args(['--allow', '127.0.0.1']));
  assert.equal(ok.code, 0);
  const bad = await go(args(['--allow', 'example.com']));
  assert.equal(bad.code, 3);
  assert.match(bad.stderr, /not on the allow list/);
  const before = origin.hits.length;
  const enforced = await go(args(['--allow', 'example.com', '--enforce']));
  assert.equal(origin.hits.length, before, 'enforced run must not reach the origin');
  assert.ok(enforced.code !== undefined);
});

test('baseline round trip: save, then pass, then fail on a new host', async (t) => {
  const origin = await httpServer();
  const other = await httpServer();
  t.after(() => Promise.all([origin.close(), other.close()]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whocalls-'));
  const file = path.join(dir, 'base.json');
  const { execFile } = await import('node:child_process');
  const go = (a) => new Promise((resolve) => execFile(process.execPath, [bin, ...a], (err) => resolve(err?.code ?? 0)));
  const base = ['--no-sample', '--include-local'];
  const cmd = (url) => ['--', process.execPath, '-e', fetcher(url)];

  assert.equal(await go([...base, '--save', file, ...cmd(`http://127.0.0.1:${origin.port}/`)]), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).hosts, ['127.0.0.1']);
  assert.equal(await go([...base, '--baseline', file, ...cmd(`http://127.0.0.1:${origin.port}/`)]), 0);
  fs.writeFileSync(file, JSON.stringify({ version: 1, hosts: ['somewhere.else'] }));
  assert.equal(await go([...base, '--baseline', file, ...cmd(`http://127.0.0.1:${other.port}/`)]), 3);
});

test('detects a connection that bypasses the proxy', { skip: !lanAddress() ? 'no non-loopback interface' : false }, async (t) => {
  if (!(await lsofAvailable())) return t.skip('lsof not available');
  const lan = /** @type {string} */ (lanAddress());
  const server = net.createServer((s) => s.on('error', () => {}));
  await new Promise((r) => server.listen(0, '0.0.0.0', () => r(undefined)));
  const port = /** @type {net.AddressInfo} */ (server.address()).port;
  const { execFile } = await import('node:child_process');
  const script = `const s=require('net').connect(${port},'${lan}',()=>setTimeout(()=>process.exit(0),1200))`;
  const out = await new Promise((resolve) =>
    execFile(process.execPath, [bin, '--json', '--interval', '50', '--', process.execPath, '-e', script], (err, stdout) => resolve(stdout)),
  );
  server.close();
  const json = JSON.parse(out);
  assert.ok(json.direct.some((d) => d.ip === lan && d.port === port), `expected direct connection to ${lan}:${port}, got ${JSON.stringify(json.direct)}`);
});
