/**
 * Browser-side instrumentation, run by Next.js on every client load before
 * React mounts. This is the canonical place to bootstrap the Datadog Browser
 * RUM SDK with the official Next.js plugin.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation-client
 */

import { datadogRum } from "@datadog/browser-rum";
import type { MatchOption } from "@datadog/browser-rum";
import { nextjsPlugin } from "@datadog/browser-rum-nextjs";

type AllowedTracingUrl = {
  match: MatchOption;
  propagatorTypes: ("tracecontext" | "datadog" | "b3" | "b3multi")[];
};

/**
 * Build the RUM `allowedTracingUrls` list.
 *
 * Always includes a same-origin matcher so browser → Next.js API calls get
 * a `traceparent` injected. Set `NEXT_PUBLIC_DATADOG_ALLOWED_TRACING_URLS`
 * to a comma-separated list of additional origins (or URL prefixes) — most
 * importantly the deployed Flask API origin, if any browser code calls it
 * directly.
 *
 * Never use `*` here — that leaks trace IDs to third-party domains.
 */
function buildAllowedTracingUrls(): AllowedTracingUrl[] {
  const urls: AllowedTracingUrl[] = [
    {
      match: (url: string) => url.startsWith(window.location.origin),
      propagatorTypes: ["tracecontext"],
    },
  ];

  const extra = process.env.NEXT_PUBLIC_DATADOG_ALLOWED_TRACING_URLS;
  if (extra) {
    for (const raw of extra.split(",")) {
      const prefix = raw.trim().replace(/\/$/, "");
      if (!prefix) continue;
      urls.push({
        match: (url: string) => url.startsWith(prefix),
        propagatorTypes: ["tracecontext"],
      });
    }
  }

  return urls;
}

const applicationId = process.env.NEXT_PUBLIC_DATADOG_APPLICATION_ID;
const clientToken = process.env.NEXT_PUBLIC_DATADOG_CLIENT_TOKEN;
const service = process.env.NEXT_PUBLIC_DATADOG_SERVICE_NAME;
const env = process.env.NEXT_PUBLIC_DATADOG_ENV;

if (applicationId && clientToken && service && env) {
  datadogRum.init({
    applicationId,
    clientToken,
    site: process.env.NEXT_PUBLIC_DATADOG_SITE || "datadoghq.com",
    service,
    env,
    // Prefer an explicit version when set, otherwise fall back to the Vercel
    // commit SHA so RUM still splits metrics by deploy.
    version:
      process.env.NEXT_PUBLIC_DATADOG_VERSION ||
      process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ||
      undefined,
    sessionSampleRate: 100,
    sessionReplaySampleRate: 100,
    trackResources: true,
    trackUserInteractions: true,
    trackLongTasks: true,
    // README §6.2: review per app. "mask-user-input" is the safer default
    // for anything handling form data; switch to "allow" only if you
    // explicitly need to capture input contents in session replays.
    defaultPrivacyLevel: "mask-user-input",
    allowedTracingUrls: buildAllowedTracingUrls(),
    plugins: [nextjsPlugin()],
  });
} else {
  console.warn(
    "[Datadog] RUM not initialized: missing NEXT_PUBLIC_DATADOG_* env vars",
    {
      hasApplicationId: !!applicationId,
      hasClientToken: !!clientToken,
      hasService: !!service,
      hasEnv: !!env,
    },
  );
}

// Required: Next.js calls this hook on every App Router transition so the
// RUM plugin can stamp a fresh view at navigation start (instead of waiting
// for the new page to commit).
export { onRouterTransitionStart } from "@datadog/browser-rum-nextjs";
