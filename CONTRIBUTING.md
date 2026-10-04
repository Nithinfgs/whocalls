# Contributing

Thanks for looking. This is a small tool and I would like to keep it small, honest and dependency-free.

## Setup

```sh
git clone https://github.com/Nithinfgs/whocalls && cd whocalls
npm install
npm run check
```

`npm run check` runs ESLint, `tsc` in `checkJs` mode, and the `node:test` suite. CI runs the same on Linux and macOS with Node 18, 20 and 24. Windows is not covered yet; help welcome.

## Ground rules

- **No runtime dependencies.** Dev dependencies are fine.
- **Never claim more than we can see.** If a feature has a blind spot, document it under "Limits" in the README.
- **Tests with the change.** Bug fixes need a test that fails without the fix. Network tests must use local servers, never the internet.
- **Keep the report readable.** It is the product. Check `npm run demo` still renders well.

## Good first contributions

- Add hosts to [`src/catalog.js`](src/catalog.js). Link the vendor documentation that names the host in your PR.
- A `/proc`-based fallback for the bypass check on Linux machines without `lsof`.
- Output formats: SARIF, GitHub step summary.
- Reports of clients that do not honour the proxy variables (include `whocalls --json` output).

## Pull requests

Small and focused. Describe what you observed, not just what you changed. Use conventional commit prefixes (`feat:`, `fix:`, `docs:`, `test:`, `chore:`) where it is natural.
