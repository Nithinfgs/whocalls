import fs from 'node:fs';
import { trace } from './trace.js';
import { renderText } from './report.js';
import { compileAllow, evaluate, loadBaseline, saveBaseline } from './policy.js';

export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const HELP = `whocalls - see every host a command talks to

Usage
  whocalls [options] -- <command> [args...]

Examples
  whocalls -- npm install
  whocalls --allow kind:registry --allow github.com -- npm ci
  whocalls --save .whocalls.json -- make build
  whocalls --baseline .whocalls.json -- make build

Options
  --allow <pattern>    Only these hosts are expected. Repeatable or comma-separated.
                       Patterns: host, *.domain, kind:registry|source|cdn|telemetry
  --enforce            Refuse proxied connections to hosts that are not allowed
  --baseline <file>    Fail if the command contacts a host that is not in <file>
  --save <file>        Write the hosts that were contacted to <file>
  --json               Print the report as JSON on stdout instead of the table on stderr
  --include-local      Also list loopback destinations
  --no-sample          Skip the check for connections that bypass the proxy
  --interval <ms>      Sampling interval for that check (default 150)
  -h, --help           Show this help
  -v, --version        Show the version

Exit status
  The command's own status, or 3 when it succeeded but a policy was violated.
`;

/**
 * @typedef {object} Options
 * @property {string[]} allow
 * @property {boolean} enforce
 * @property {string} [baseline]
 * @property {string} [save]
 * @property {boolean} json
 * @property {boolean} includeLocal
 * @property {boolean} sample
 * @property {number} [interval]
 * @property {boolean} help
 * @property {boolean} version
 * @property {string[]} command
 */

/**
 * Hand-rolled so that everything after the first non-option (or `--`) is the command, untouched.
 * @param {string[]} argv
 * @returns {Options}
 */
export function parseArgs(argv) {
  /** @type {Options} */
  const o = { allow: [], enforce: false, json: false, includeLocal: false, sample: true, help: false, version: false, command: [] };
  const valueOf = (i, name) => {
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${name} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      o.command = argv.slice(i + 1);
      break;
    }
    if (!a.startsWith('-')) {
      o.command = argv.slice(i);
      break;
    }
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const take = () => {
      if (inline !== undefined) return inline;
      const v = valueOf(i, flag);
      i++;
      return v;
    };
    switch (flag) {
      case '--allow':
        o.allow.push(...take().split(',').filter(Boolean));
        break;
      case '--enforce':
        o.enforce = true;
        break;
      case '--baseline':
        o.baseline = take();
        break;
      case '--save':
        o.save = take();
        break;
      case '--json':
        o.json = true;
        break;
      case '--include-local':
        o.includeLocal = true;
        break;
      case '--no-sample':
        o.sample = false;
        break;
      case '--interval': {
        const n = Number(take());
        if (!Number.isFinite(n) || n < 20) throw new Error('--interval must be a number of at least 20 (ms)');
        o.interval = n;
        break;
      }
      case '-h':
      case '--help':
        o.help = true;
        break;
      case '-v':
      case '--version':
        o.version = true;
        break;
      default:
        throw new Error(`unknown option ${flag}`);
    }
  }
  if (o.enforce && o.allow.length === 0) throw new Error('--enforce needs at least one --allow');
  return o;
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} process exit code
 */
export async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`whocalls: ${/** @type {Error} */ (err).message}\n\n${HELP}`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (opts.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (opts.command.length === 0) {
    process.stderr.write(`whocalls: no command given\n\n${HELP}`);
    return 2;
  }

  let allow = null;
  let baseline = null;
  try {
    if (opts.allow.length) allow = compileAllow(opts.allow);
    if (opts.baseline) baseline = loadBaseline(opts.baseline);
  } catch (err) {
    process.stderr.write(`whocalls: ${/** @type {Error} */ (err).message}\n`);
    return 2;
  }

  const result = await trace(opts.command, {
    allow: opts.enforce && allow ? (host) => allow(host) : undefined,
    sample: opts.sample,
    intervalMs: opts.interval,
    includeLocal: opts.includeLocal,
    // keep stdout clean for the command; JSON mode also silences nothing of the child's output
  });

  if (result.spawnError) {
    process.stderr.write(`whocalls: could not run "${opts.command[0]}": ${result.spawnError.message}\n`);
    return result.exitCode;
  }

  const violations = evaluate(result.report, { allow, baseline });
  const commandText = opts.command.join(' ');
  if (opts.save) saveBaseline(opts.save, result.report.hosts.map((h) => h.host));

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          version: 1,
          command: opts.command,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          hosts: result.report.hosts,
          direct: result.report.direct,
          violations,
          notes: result.notes,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    const color = (Boolean(process.stderr.isTTY) || Boolean(process.env.FORCE_COLOR)) && !process.env.NO_COLOR;
    process.stderr.write(
      renderText({ command: commandText, exitCode: result.exitCode, durationMs: result.durationMs, report: result.report, violations, notes: result.notes, color }),
    );
  }

  if (result.exitCode === 0 && violations.length > 0) return 3;
  return result.exitCode;
}
