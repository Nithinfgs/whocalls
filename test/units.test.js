import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/catalog.js';
import { compileAllow, evaluate } from '../src/policy.js';
import { buildReport, formatBytes, renderText } from '../src/report.js';
import { parseLsof, descendants, splitEndpoint } from '../src/sampler.js';
import { parseArgs } from '../src/cli.js';
import { proxyEnv } from '../src/trace.js';

test('classify labels well-known hosts', () => {
  assert.equal(classify('registry.npmjs.org'), 'registry');
  assert.equal(classify('telemetry.nextjs.org'), 'telemetry');
  assert.equal(classify('o123.ingest.sentry.io'), 'telemetry');
  assert.equal(classify('github.com'), 'source');
  assert.equal(classify('example.com'), 'other');
  assert.equal(classify('notgithub.com'), 'other');
});

test('compileAllow matches hosts, wildcards and kinds', () => {
  const ok = compileAllow(['github.com', '*.example.org', 'kind:registry']);
  assert.ok(ok('github.com'));
  assert.ok(ok('a.b.example.org'));
  assert.ok(ok('example.org'));
  assert.ok(ok('pypi.org'));
  assert.ok(!ok('evilgithub.com'));
  assert.ok(!ok('example.org.evil.com'));
  assert.throws(() => compileAllow(['kind:nonsense']));
});

/** @returns {import('../src/proxy.js').Flow} */
const flow = (host, extra = {}) => ({ id: 1, scheme: /** @type {'https'} */ ('https'), host, port: 443, method: 'CONNECT', bytesUp: 10, bytesDown: 100, startedAt: 0, durationMs: 5, outcome: /** @type {'ok'} */ ('ok'), ...extra });

test('buildReport groups by host and hides loopback by default', () => {
  const report = buildReport([flow('a.com'), flow('a.com', { bytesDown: 900, ip: '1.2.3.4' }), flow('127.0.0.1')], []);
  assert.equal(report.hosts.length, 1);
  assert.equal(report.hosts[0].connections, 2);
  assert.equal(report.hosts[0].bytesDown, 1000);
  assert.equal(buildReport([flow('127.0.0.1')], [], { includeLocal: true }).hosts.length, 1);
});

test('direct connections are matched to hosts seen through the proxy', () => {
  /** @type {import('../src/sampler.js').DirectConn[]} */
  const direct = [{ pid: 7, command: 'java', proto: 'TCP', ip: '1.2.3.4', port: 443 }];
  const report = buildReport([flow('a.com', { ip: '1.2.3.4' })], direct);
  assert.equal(report.direct[0].knownAs, 'a.com');
});

test('evaluate flags hosts outside the allow list and unknown direct connections', () => {
  const report = buildReport([flow('registry.npmjs.org'), flow('evil.example')], [{ pid: 1, command: 'node', proto: /** @type {'TCP'} */ ('TCP'), ip: '9.9.9.9', port: 443 }]);
  const v = evaluate(report, { allow: compileAllow(['kind:registry']) });
  assert.deepEqual(v.map((x) => [x.type, x.host]), [['not-allowed', 'evil.example'], ['direct', '9.9.9.9']]);
  assert.deepEqual(evaluate(report, {}), [], 'no policy means no violations');
});

test('evaluate with a baseline reports only new hosts', () => {
  const report = buildReport([flow('a.com'), flow('b.com')], []);
  const v = evaluate(report, { baseline: ['a.com'] });
  assert.deepEqual(v.map((x) => [x.type, x.host]), [['new-host', 'b.com']]);
});

test('parseLsof extracts remote endpoints and ignores listeners', () => {
  const text = [
    'p100', 'cnode',
    'f20', 'PTCP', 'n10.0.0.5:51000->93.184.216.34:443', 'TST=ESTABLISHED', 'TQR=0',
    'f21', 'PTCP', 'n*:3000', 'TST=LISTEN',
    'f22', 'PTCP', 'n[fe80::1]:5000->[2606:2800::1]:80', 'TST=SYN_SENT',
    'p200', 'ccurl',
    'f5', 'PUDP', 'n10.0.0.5:5000->1.1.1.1:53',
    '',
  ].join('\n');
  const conns = parseLsof(text);
  assert.deepEqual(conns.map((c) => [c.pid, c.command, c.proto, c.ip, c.port, c.state]), [
    [100, 'node', 'TCP', '93.184.216.34', 443, 'ESTABLISHED'],
    [100, 'node', 'TCP', '2606:2800::1', 80, 'SYN_SENT'],
    [200, 'curl', 'UDP', '1.1.1.1', 53, undefined],
  ]);
});

test('descendants walks the process tree', () => {
  const ps = ' 1 0\n 10 1\n 11 10\n 12 11\n 20 1\n';
  assert.deepEqual(descendants(ps, 10).sort((a, b) => a - b), [10, 11, 12]);
});

test('splitEndpoint', () => {
  assert.deepEqual(splitEndpoint('[::1]:80'), { ip: '::1', port: 80 });
  assert.deepEqual(splitEndpoint('1.2.3.4:443'), { ip: '1.2.3.4', port: 443 });
});

test('formatBytes', () => {
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1500), '1.5 KB');
  assert.equal(formatBytes(48_000_000), '48 MB');
});

test('parseArgs splits options from the command and keeps the command intact', () => {
  const o = parseArgs(['--allow', 'a.com,b.com', '--json', '--', 'npm', 'install', '--save-dev', 'x']);
  assert.deepEqual(o.allow, ['a.com', 'b.com']);
  assert.ok(o.json);
  assert.deepEqual(o.command, ['npm', 'install', '--save-dev', 'x']);
  assert.deepEqual(parseArgs(['make', '-j4']).command, ['make', '-j4']);
  assert.throws(() => parseArgs(['--nope', '--', 'x']), /unknown option/);
  assert.throws(() => parseArgs(['--enforce', '--', 'x']), /--allow/);
  assert.throws(() => parseArgs(['--allow']), /needs a value/);
});

test('proxyEnv overrides inherited proxy and no_proxy settings', () => {
  const env = proxyEnv({ NO_PROXY: 'internal', HTTPS_PROXY: 'http://corp:1' }, 4242);
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:4242');
  assert.equal(env.NO_PROXY, '');
  assert.equal(env.NODE_USE_ENV_PROXY, '1');
});

test('renderText marks violations and says so when nothing was contacted', () => {
  const none = renderText({ command: 'true', exitCode: 0, durationMs: 5, report: { hosts: [], direct: [] }, violations: [], notes: [], color: false });
  assert.match(none, /No outbound connections observed/);
  const report = buildReport([flow('evil.example')], []);
  const text = renderText({ command: 'x', exitCode: 0, durationMs: 5, report, violations: [{ type: 'not-allowed', host: 'evil.example', detail: 'not on the allow list' }], notes: [], color: false });
  assert.match(text, /Policy: 1 violation/);
  assert.match(text, /evil\.example/);
});
