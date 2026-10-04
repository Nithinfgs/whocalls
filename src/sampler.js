import { execFile } from 'node:child_process';

/**
 * @typedef {object} DirectConn
 * @property {number} pid
 * @property {string} command
 * @property {'TCP'|'UDP'} proto
 * @property {string} ip
 * @property {number} port
 * @property {string} [state]
 */

export function isLoopback(ip) {
  return ip === '::1' || ip.startsWith('127.') || ip === '::ffff:127.0.0.1' || ip === 'localhost';
}

/** Split "ip:port" or "[v6]:port" into its parts. */
export function splitEndpoint(text) {
  const i = text.lastIndexOf(':');
  if (i === -1) return null;
  let ip = text.slice(0, i);
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const port = Number(text.slice(i + 1));
  return Number.isInteger(port) ? { ip, port } : null;
}

/**
 * Parse `lsof -F pcfPnT` output into connections that have a remote end.
 * @param {string} text
 * @returns {DirectConn[]}
 */
export function parseLsof(text) {
  /** @type {DirectConn[]} */
  const out = [];
  let pid = 0;
  let command = '';
  /** @type {{proto?: string, name?: string, state?: string} | null} */
  let fd = null;
  const flush = () => {
    if (!fd?.name?.includes('->')) return;
    const remote = splitEndpoint(fd.name.split('->')[1].trim());
    if (!remote || (fd.proto !== 'TCP' && fd.proto !== 'UDP')) return;
    out.push({ pid, command, proto: fd.proto, ip: remote.ip, port: remote.port, state: fd.state });
  };
  for (const line of text.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      flush();
      fd = null;
      pid = Number(value);
    } else if (tag === 'c') command = value;
    else if (tag === 'f') {
      flush();
      fd = {};
    } else if (fd && tag === 'P') fd.proto = value;
    else if (fd && tag === 'n') fd.name = value;
    else if (fd && tag === 'T' && value.startsWith('ST=')) fd.state = value.slice(3);
  }
  flush();
  return out;
}

/** Parse `ps -A -o pid=,ppid=` and return `root` plus all of its descendants. */
export function descendants(psText, root) {
  const kids = new Map();
  for (const line of psText.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const list = kids.get(Number(m[2])) ?? [];
    list.push(Number(m[1]));
    kids.set(Number(m[2]), list);
  }
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length) for (const k of kids.get(queue.shift()) ?? []) if (!seen.has(k)) (seen.add(k), queue.push(k));
  return [...seen];
}

function run(file, args) {
  return new Promise((resolve) => {
    // lsof exits 1 when nothing matches, which is a normal answer for us.
    execFile(file, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err && /** @type {any} */ (err).code === 'ENOENT') resolve(null);
      else resolve(stdout ?? '');
    });
  });
}

/** True when lsof is usable on this machine. */
export async function lsofAvailable() {
  if (process.platform === 'win32') return false;
  return (await run('lsof', ['-v'])) !== null;
}

/**
 * Poll the process tree rooted at `rootPid` for sockets that go somewhere other than loopback.
 * Connections shorter than one polling interval can be missed; that limit is reported to users.
 *
 * @param {number} rootPid
 * @param {{ intervalMs?: number, onConn: (c: DirectConn) => void }} options
 */
export function startSampler(rootPid, { intervalMs = 150, onConn }) {
  let stopped = false;
  const seen = new Set();
  const loop = async () => {
    while (!stopped) {
      const ps = await run('ps', ['-A', '-o', 'pid=,ppid=']);
      const pids = ps ? descendants(ps, rootPid) : [rootPid];
      const text = await run('lsof', ['-nP', '-a', '-p', pids.join(','), '-i', '-F', 'pcfPnT']);
      for (const c of parseLsof(text ?? '')) {
        if (isLoopback(c.ip)) continue;
        if (c.proto === 'TCP' && c.state && !['ESTABLISHED', 'SYN_SENT', 'CLOSE_WAIT', 'FIN_WAIT_1', 'FIN_WAIT_2'].includes(c.state)) continue;
        const key = `${c.pid}|${c.proto}|${c.ip}|${c.port}`;
        if (seen.has(key)) continue;
        seen.add(key);
        onConn(c);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };
  const done = loop();
  return {
    async stop() {
      stopped = true;
      await done;
    },
  };
}
