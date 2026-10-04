/**
 * A small, hand-maintained catalogue used to label hosts. It is a hint, not a verdict:
 * anything not listed is simply "other", and that is not a statement that it is bad.
 * Entries starting with "." match the domain and all of its subdomains.
 */

/** @typedef {'registry'|'source'|'cdn'|'telemetry'|'other'} Kind */

/** @type {Record<Exclude<Kind,'other'>, string[]>} */
const CATALOG = {
  registry: [
    'registry.npmjs.org', 'registry.yarnpkg.com', 'pypi.org', 'files.pythonhosted.org',
    'crates.io', 'static.crates.io', 'index.crates.io', 'proxy.golang.org', 'sum.golang.org',
    'rubygems.org', 'index.rubygems.org', 'repo.maven.apache.org', 'repo1.maven.org',
    'plugins.gradle.org', 'services.gradle.org', 'registry-1.docker.io', 'auth.docker.io',
    'production.cloudflare.docker.com', 'ghcr.io', 'api.nuget.org', 'repo.packagist.org',
    'hex.pm', 'repo.hex.pm', 'pub.dev', 'storage.googleapis.com/pub-packages',
  ],
  source: [
    'github.com', 'api.github.com', 'codeload.github.com', 'raw.githubusercontent.com',
    'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'gitlab.com', 'bitbucket.org',
  ],
  cdn: ['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'esm.sh', 'cdn.skypack.dev'],
  telemetry: [
    'telemetry.nextjs.org', 'api.segment.io', 'cdn.segment.com', '.ingest.sentry.io', 'sentry.io',
    'app.posthog.com', 'us.i.posthog.com', 'eu.i.posthog.com', 'api.amplitude.com',
    'api2.amplitude.com', 'api.mixpanel.com', 'www.google-analytics.com',
    'region1.google-analytics.com', 'analytics.google.com', 'stats.g.doubleclick.net',
    '.datadoghq.com', 'api.honeycomb.io', 'otlp.nr-data.net', 'sessions.bugsnag.com',
    'notify.bugsnag.com', 'api.rollbar.com', 'vitals.vercel-insights.com',
    'dc.services.visualstudio.com', 'vortex.data.microsoft.com',
  ],
};

/** @type {Map<string, Kind>} */
const exact = new Map();
/** @type {Array<[string, Kind]>} */
const suffixes = [];
for (const [kind, hosts] of Object.entries(CATALOG)) {
  for (const h of hosts) {
    if (h.startsWith('.')) suffixes.push([h, /** @type {Kind} */ (kind)]);
    else exact.set(h, /** @type {Kind} */ (kind));
  }
}

/**
 * @param {string} host lower-case hostname
 * @returns {Kind}
 */
export function classify(host) {
  const hit = exact.get(host);
  if (hit) return hit;
  for (const [suffix, kind] of suffixes) if (host.endsWith(suffix) || host === suffix.slice(1)) return kind;
  return 'other';
}

export const KIND_LABEL = {
  registry: 'package registry',
  source: 'source host',
  cdn: 'cdn',
  telemetry: 'telemetry',
  other: 'other',
};
