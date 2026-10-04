# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-04

### Added
- `whocalls -- <command>`: run a command behind a local forward proxy and report the hosts it contacts, with connection counts and bytes sent and received.
- HTTPS is tunnelled via `CONNECT` and never decrypted. Plain HTTP records the path but not the query string.
- Bypass detection: a `ps` + `lsof` sampler reports sockets of the command's process tree that did not use the proxy.
- Host labels for package registries, source hosts, CDNs and known telemetry endpoints.
- `--allow`, `--enforce`, `--baseline`, `--save` for allowlists and CI gating; exit code 3 on policy violation.
- Chaining through an existing `HTTP_PROXY` / `HTTPS_PROXY`, honouring `NO_PROXY`.
- `--json` output.
