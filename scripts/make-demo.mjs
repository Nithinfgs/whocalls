/* eslint-disable no-control-regex -- ANSI escape sequences are the whole point of this script */
// Renders real whocalls output to docs/assets/demo.svg so the README never shows made-up output.
// Usage: node scripts/make-demo.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const bin = 'npx whocalls';
const steps = [
  { cmd: `${bin} -- node examples/chatty-build/build.mjs`, args: ['bin/whocalls.js', '--', 'node', 'examples/chatty-build/build.mjs'] },
  { cmd: `${bin} --allow kind:registry --allow kind:source \\\n    -- node examples/chatty-build/build.mjs`, args: ['bin/whocalls.js', '--allow', 'kind:registry', '--allow', 'kind:source', '--', 'node', 'examples/chatty-build/build.mjs'] },
];

const COLORS = { 31: '#ff7b72', 32: '#7ee787', 33: '#e3b341', 36: '#79c0ff' };
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Turn one line with SGR codes into <tspan>s. */
function spans(line) {
  let bold = false, dim = false, color = null, out = '';
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    const m = /^\x1b\[([0-9;]*)m$/.exec(part);
    if (m) {
      for (const code of m[1].split(';').map(Number)) {
        if (code === 0) (bold = false, dim = false, color = null);
        else if (code === 1) bold = true;
        else if (code === 2) dim = true;
        else if (COLORS[code]) color = COLORS[code];
      }
    } else if (part) {
      const fill = color ?? (dim ? '#8b949e' : '#e6edf3');
      out += `<tspan fill="${fill}"${bold ? ' font-weight="700"' : ''}>${esc(part)}</tspan>`;
    }
  }
  return out;
}

const lines = [];
for (const step of steps) {
  lines.push(...`\x1b[32m$\x1b[0m ${step.cmd}`.split('\n'));
  const r = spawnSync(process.execPath, step.args, { cwd: root, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '1', NO_COLOR: '' } });
  lines.push(...r.stdout.trimEnd().split('\n'), ...r.stderr.replace(/^\n/, '').trimEnd().split('\n'), '');
}
// Drop the "HTTPS is tunnelled" note lines in the image; they are in the README instead.
const shown = lines.filter((l) => !l.includes('tunnelled'));
while (shown.at(-1) === '') shown.pop();

const lh = 20, pad = 20, top = 44;
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const cols = Math.max(...shown.map((l) => strip(l).length));
const width = Math.max(760, Math.ceil(cols * 8.8) + pad * 2);
const height = top + shown.length * lh + pad;
const body = shown.map((l, i) => `<text x="${pad}" y="${top + i * lh}" xml:space="preserve">${spans(l)}</text>`).join('\n');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Terminal output of whocalls running a build">
<rect width="${width}" height="${height}" rx="10" fill="#0d1117"/>
<circle cx="22" cy="20" r="6" fill="#ff5f56"/><circle cx="42" cy="20" r="6" fill="#ffbd2e"/><circle cx="62" cy="20" r="6" fill="#27c93f"/>
<g font-family="SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace" font-size="14">
${body}
</g>
</svg>
`;
fs.mkdirSync(new URL('../docs/assets/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../docs/assets/demo.svg', import.meta.url), svg);
console.log(`wrote docs/assets/demo.svg (${svg.length} bytes, ${shown.length} lines)`);
