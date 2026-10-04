import fs from 'node:fs';
import { classify } from './catalog.js';

/**
 * Compile allow patterns into a predicate.
 * Supported: exact host or IP, "*.example.com" (subdomains and the apex), and "kind:registry|source|cdn|telemetry".
 * @param {string[]} patterns
 * @returns {(host: string) => boolean}
 */
export function compileAllow(patterns) {
  const tests = patterns.map((raw) => {
    const p = raw.trim().toLowerCase();
    if (p.startsWith('kind:')) {
      const kind = p.slice(5);
      if (!['registry', 'source', 'cdn', 'telemetry'].includes(kind)) throw new Error(`unknown kind in "${raw}"`);
      return (host) => classify(host) === kind;
    }
    if (p.startsWith('*.')) {
      const base = p.slice(2);
      return (host) => host === base || host.endsWith(`.${base}`);
    }
    if (p === '*') return () => true;
    return (host) => host === p;
  });
  return (host) => tests.some((t) => t(host.toLowerCase()));
}

/** @param {string} file */
export function loadBaseline(file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read baseline ${file}: ${/** @type {Error} */ (err).message}`);
  }
  if (!Array.isArray(data?.hosts)) throw new Error(`baseline ${file} has no "hosts" array`);
  return /** @type {string[]} */ (data.hosts);
}

/**
 * @param {string} file
 * @param {string[]} hosts
 */
export function saveBaseline(file, hosts) {
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, hosts: [...new Set(hosts)].sort() }, null, 2)}\n`);
}

/**
 * @typedef {object} Violation
 * @property {'not-allowed'|'new-host'|'direct'} type
 * @property {string} host
 * @property {string} detail
 */

/**
 * @param {import('./report.js').Report} report
 * @param {{ allow?: ((host: string) => boolean) | null, baseline?: string[] | null }} policy
 * @returns {Violation[]}
 */
export function evaluate(report, { allow = null, baseline = null }) {
  /** @type {Violation[]} */
  const out = [];
  const known = baseline ? new Set(baseline) : null;
  const permitted = (host) => (allow ? allow(host) : false) || (known ? known.has(host) : false);
  const active = Boolean(allow || known);
  if (!active) return out;

  for (const h of report.hosts) {
    if (permitted(h.host)) continue;
    if (known && !allow) out.push({ type: 'new-host', host: h.host, detail: 'not in baseline' });
    else out.push({ type: 'not-allowed', host: h.host, detail: 'not on the allow list' });
  }
  for (const d of report.direct) {
    if (permitted(d.ip) || (d.knownAs && permitted(d.knownAs))) continue;
    out.push({
      type: 'direct',
      host: d.knownAs ?? d.ip,
      detail: `${d.command} (pid ${d.pid}) bypassed the proxy to reach ${d.ip}:${d.port}`,
    });
  }
  return out;
}
