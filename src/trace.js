import { spawn } from 'node:child_process';
import { createProxy, upstreamFromEnv } from './proxy.js';
import { startSampler, lsofAvailable } from './sampler.js';
import { buildReport } from './report.js';

/**
 * Environment that points common clients at the proxy.
 * @param {NodeJS.ProcessEnv} base
 * @param {number} port
 */
export function proxyEnv(base, port) {
  const url = `http://127.0.0.1:${port}`;
  const env = { ...base };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) env[k] = url;
  env.npm_config_proxy = url;
  env.npm_config_https_proxy = url;
  // We want every host, so nothing may be exempted. Loopback is filtered in the report instead.
  env.NO_PROXY = '';
  env.no_proxy = '';
  env.npm_config_noproxy = '';
  // Node 22.21+/24+ only honours the variables above when this is set.
  env.NODE_USE_ENV_PROXY = '1';
  return env;
}

/**
 * Run a command with its traffic observed.
 *
 * @param {string[]} argv command and arguments
 * @param {object} [options]
 * @param {(host: string, port: number) => boolean} [options.allow]  enforcement predicate
 * @param {boolean} [options.sample]   watch for connections that bypass the proxy (default true)
 * @param {number} [options.intervalMs]
 * @param {boolean} [options.includeLocal]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {import('node:child_process').StdioOptions} [options.stdio]
 */
export async function trace(argv, options = {}) {
  const { allow, sample = true, intervalMs, includeLocal = false, env = process.env, stdio = 'inherit' } = options;
  /** @type {import('./proxy.js').Flow[]} */
  const flows = [];
  /** @type {import('./sampler.js').DirectConn[]} */
  const directs = [];
  /** @type {string[]} */
  const notes = [];

  const upstream = upstreamFromEnv(env);
  const proxy = createProxy({ allow, upstream, onFlow: (f) => flows.push(f) });
  const port = await proxy.listen();
  const started = Date.now();

  const child = spawn(argv[0], argv.slice(1), {
    stdio,
    env: proxyEnv(env, port),
    shell: process.platform === 'win32',
  });

  /** @type {Array<['SIGINT'|'SIGTERM', () => void]>} */
  const handlers = [
    ['SIGINT', () => child.kill('SIGINT')],
    ['SIGTERM', () => child.kill('SIGTERM')],
  ];
  for (const [s, h] of handlers) process.on(s, h);

  let sampler = null;
  if (sample) {
    if (await lsofAvailable()) {
      sampler = startSampler(/** @type {number} */ (child.pid), { intervalMs, onConn: (c) => directs.push(c) });
    } else {
      notes.push('lsof not found: could not look for connections that bypass the proxy');
    }
  }

  /** @type {{ code: number, error?: Error }} */
  const result = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: /** @type {any} */ (error).code === 'ENOENT' ? 127 : 126, error }));
    child.once('exit', (code, signal) => resolve({ code: code ?? 128 + (signal ? signalNumber(signal) : 0) }));
  });

  for (const [s, h] of handlers) process.off(s, h);
  await sampler?.stop();
  await proxy.close();

  const report = buildReport(flows, directs, { includeLocal });
  if (flows.some((f) => f.scheme === 'https')) {
    notes.push('HTTPS is tunnelled, not decrypted: only the host and byte counts are visible');
  }
  return { exitCode: result.code, spawnError: result.error, durationMs: Date.now() - started, report, flows, notes };
}

function signalNumber(signal) {
  const table = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
  return table[signal] ?? 1;
}
