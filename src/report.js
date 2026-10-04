import { classify, KIND_LABEL } from './catalog.js';
import { isLoopback } from './sampler.js';

/**
 * @typedef {object} HostRow
 * @property {string} host
 * @property {import('./catalog.js').Kind} kind
 * @property {number[]} ports
 * @property {number} connections
 * @property {number} bytesUp
 * @property {number} bytesDown
 * @property {boolean} plainHttp
 * @property {number} blocked
 * @property {number} errors
 * @property {string[]} ips
 */

/**
 * @typedef {object} DirectRow
 * @property {string} ip
 * @property {number} port
 * @property {number} pid
 * @property {string} command
 * @property {string} proto
 * @property {string} [knownAs]  hostname the proxy saw for the same IP, if any
 */

/**
 * @typedef {object} Report
 * @property {HostRow[]} hosts
 * @property {DirectRow[]} direct
 */

/**
 * @param {import('./proxy.js').Flow[]} flows
 * @param {import('./sampler.js').DirectConn[]} directs
 * @param {{ includeLocal?: boolean }} [options]
 * @returns {Report}
 */
export function buildReport(flows, directs, { includeLocal = false } = {}) {
  /** @type {Map<string, HostRow>} */
  const rows = new Map();
  /** @type {Map<string, string>} */
  const ipToHost = new Map();

  for (const f of flows) {
    if (!includeLocal && isLoopback(f.host)) continue;
    let row = rows.get(f.host);
    if (!row) {
      row = {
        host: f.host,
        kind: classify(f.host),
        ports: [],
        connections: 0,
        bytesUp: 0,
        bytesDown: 0,
        plainHttp: false,
        blocked: 0,
        errors: 0,
        ips: [],
      };
      rows.set(f.host, row);
    }
    row.connections++;
    row.bytesUp += f.bytesUp;
    row.bytesDown += f.bytesDown;
    if (!row.ports.includes(f.port)) row.ports.push(f.port);
    if (f.scheme === 'http') row.plainHttp = true;
    if (f.outcome === 'blocked') row.blocked++;
    if (f.outcome === 'error') row.errors++;
    if (f.ip) {
      if (!row.ips.includes(f.ip)) row.ips.push(f.ip);
      ipToHost.set(f.ip, f.host);
    }
  }

  const hosts = [...rows.values()].sort(
    (a, b) => b.bytesUp + b.bytesDown - (a.bytesUp + a.bytesDown) || a.host.localeCompare(b.host),
  );
  const direct = directs
    .filter((d) => includeLocal || !isLoopback(d.ip))
    .map((d) => ({ ip: d.ip, port: d.port, pid: d.pid, command: d.command, proto: d.proto, knownAs: ipToHost.get(d.ip) }));
  return { hosts, direct };
}

export function formatBytes(n) {
  if (n < 1000) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n;
  let i = -1;
  do {
    v /= 1000;
    i++;
  } while (v >= 1000 && i < units.length - 1);
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function formatDuration(ms) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** @param {boolean} on */
function palette(on) {
  const wrap = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { bold: wrap('1'), dim: wrap('2'), red: wrap('31'), yellow: wrap('33'), green: wrap('32'), cyan: wrap('36') };
}

/**
 * @param {object} input
 * @param {string} input.command
 * @param {number} input.exitCode
 * @param {number} input.durationMs
 * @param {Report} input.report
 * @param {import('./policy.js').Violation[]} input.violations
 * @param {string[]} input.notes
 * @param {boolean} input.color
 */
export function renderText({ command, exitCode, durationMs, report, violations, notes, color }) {
  const c = palette(color);
  const lines = [];
  lines.push('');
  lines.push(`${c.bold('whocalls')} ${c.dim('·')} ${command} ${c.dim(`· exit ${exitCode} · ${formatDuration(durationMs)}`)}`);
  lines.push('');

  const violating = new Set(violations.map((v) => v.host));
  const table = report.hosts.map((h) => {
    const flags = [];
    if (h.plainHttp) flags.push('plain http');
    if (h.blocked) flags.push(`${h.blocked} blocked`);
    if (h.errors) flags.push(`${h.errors} failed`);
    return {
      host: h.host + (h.ports.some((p) => p !== 443 && p !== 80) ? `:${h.ports.filter((p) => p !== 443 && p !== 80).join(',')}` : ''),
      kind: KIND_LABEL[h.kind],
      conns: String(h.connections),
      up: formatBytes(h.bytesUp),
      down: formatBytes(h.bytesDown),
      flags: flags.join(', '),
      raw: h,
    };
  });
  if (table.length === 0 && report.direct.length === 0) {
    lines.push(`  ${c.green('No outbound connections observed.')}`);
  } else if (table.length > 0) {
    const w = (key, head) => Math.max(head.length, ...table.map((r) => r[key].length));
    const cols = { host: w('host', 'HOST'), kind: w('kind', 'KIND'), conns: w('conns', 'CONNS'), up: w('up', 'SENT'), down: w('down', 'RECEIVED') };
    lines.push(
      `  ${c.dim(
        `${'HOST'.padEnd(cols.host)}  ${'KIND'.padEnd(cols.kind)}  ${'CONNS'.padStart(cols.conns)}  ${'SENT'.padStart(cols.up)}  ${'RECEIVED'.padStart(cols.down)}`,
      )}`,
    );
    for (const r of table) {
      const kindText = r.raw.kind === 'telemetry' ? c.yellow(r.kind.padEnd(cols.kind)) : r.kind.padEnd(cols.kind);
      const hostText = violating.has(r.raw.host) ? c.red(r.host.padEnd(cols.host)) : r.host.padEnd(cols.host);
      lines.push(
        `  ${hostText}  ${kindText}  ${r.conns.padStart(cols.conns)}  ${r.up.padStart(cols.up)}  ${r.down.padStart(cols.down)}${r.flags ? `  ${c.yellow(r.flags)}` : ''}`,
      );
    }
  }

  if (report.direct.length > 0) {
    if (table.length > 0) lines.push('');
    lines.push(`  ${c.yellow('Connections that did not go through the proxy:')}`);
    for (const d of report.direct) {
      const ip = d.ip.includes(':') ? `[${d.ip}]` : d.ip;
      const name = d.knownAs ? `${d.knownAs} (${ip})` : ip;
      lines.push(`    ${c.yellow('!')} ${name}:${d.port} ${c.dim(`${d.proto.toLowerCase()} · ${d.command} (pid ${d.pid})`)}`);
    }
  }

  const telemetry = report.hosts.filter((h) => h.kind === 'telemetry').length;
  lines.push('');
  const parts = [`${report.hosts.length} host${report.hosts.length === 1 ? '' : 's'} via proxy`];
  if (report.direct.length) parts.push(`${report.direct.length} direct`);
  if (telemetry) parts.push(`${telemetry} known telemetry`);
  lines.push(`  ${parts.join(c.dim(' · '))}`);

  if (violations.length) {
    lines.push('');
    lines.push(`  ${c.red(c.bold(`Policy: ${violations.length} violation${violations.length === 1 ? '' : 's'}`))}`);
    for (const v of violations) lines.push(`    ${c.red('✗')} ${v.host} ${c.dim(`- ${v.detail}`)}`);
  }
  for (const n of notes) lines.push(`  ${c.dim(`note: ${n}`)}`);
  lines.push('');
  return lines.join('\n');
}
