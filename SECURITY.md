# Security policy

## Reporting a vulnerability

Please report privately through GitHub: **Security** tab, then **Report a vulnerability**. Please do not open a public issue for security problems. I aim to acknowledge within a week.

## What matters here

- The proxy listens on `127.0.0.1` on a random port for the lifetime of one command. Any local process of the same machine can reach it during that time. Do not run `whocalls` on shared machines for commands that carry secrets in plain HTTP.
- HTTPS traffic is tunnelled and never decrypted. Plain HTTP request paths are recorded in memory (never query strings, headers or bodies) and are only written out in the report you ask for.
- `whocalls` is an observer, not a sandbox. See the limits in the README before relying on `--enforce` as a security boundary.
- Credentials in `HTTP_PROXY` URLs are forwarded to your upstream proxy and never printed.

## Supported versions

Only the latest release.
