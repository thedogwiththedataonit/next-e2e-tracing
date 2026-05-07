"use client";

/**
 * Browser RUM init module — pattern from the project README §6.
 *
 * Rules preserved here:
 * - Dynamic `import()` keeps the SDK out of the initial JS bundle.
 * - Module-level flags make init idempotent across React strict-mode re-mounts.
 * - Skipped in `NODE_ENV === "development"` to avoid polluting analytics.
 * - Hard-fail closed (warn, don't throw) when env vars are missing.
 * - All public APIs are async + fire-and-forget.
 */

import type { MatchOption, User } from "@datadog/browser-rum";

type AllowedTracingUrl = {
  match: MatchOption;
  propagatorTypes: ("tracecontext" | "datadog" | "b3" | "b3multi")[];
};

let isInitialized = false;
let initializationPromise: Promise<void> | null = null;
let initializationAttempted = false;

/**
 * Build the RUM `allowedTracingUrls` list.
 *
 * - Always includes a same-origin matcher so browser → Next.js API calls get
 *   a `traceparent` injected (works on localhost, Vercel preview URLs, and
 *   prod without per-env config).
 * - Additional cross-origin tracing targets — most importantly the deployed
 *   Flask API origin — can be added by setting
 *   `NEXT_PUBLIC_DATADOG_ALLOWED_TRACING_URLS` to a comma-separated list of
 *   origins or URL prefixes (e.g.
 *   `https://flask-api.vercel.app,https://api.example.com`). Each entry is
 *   matched as a prefix against outbound URLs.
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

async function initializeDatadog(): Promise<void> {
  if (isInitialized) {
    return;
  }

  if (initializationPromise) {
    return initializationPromise;
  }

  initializationAttempted = true;

  if (process.env.NODE_ENV === "development") {
    console.log("[Datadog] Initialization skipped in development mode");
    return;
  }

  if (
    !process.env.NEXT_PUBLIC_DATADOG_APPLICATION_ID ||
    !process.env.NEXT_PUBLIC_DATADOG_CLIENT_TOKEN ||
    !process.env.NEXT_PUBLIC_DATADOG_SERVICE_NAME ||
    !process.env.NEXT_PUBLIC_DATADOG_ENV
  ) {
    console.warn(
      "[Datadog] Initialization skipped: Missing required environment variables",
      {
        hasAppId: !!process.env.NEXT_PUBLIC_DATADOG_APPLICATION_ID,
        hasClientToken: !!process.env.NEXT_PUBLIC_DATADOG_CLIENT_TOKEN,
        hasServiceName: !!process.env.NEXT_PUBLIC_DATADOG_SERVICE_NAME,
        hasEnv: !!process.env.NEXT_PUBLIC_DATADOG_ENV,
      },
    );
    return;
  }

  initializationPromise = (async () => {
    try {
      const { datadogRum } = await import("@datadog/browser-rum");

      datadogRum.init({
        applicationId: process.env.NEXT_PUBLIC_DATADOG_APPLICATION_ID!,
        clientToken: process.env.NEXT_PUBLIC_DATADOG_CLIENT_TOKEN!,
        site: "datadoghq.com",
        service: process.env.NEXT_PUBLIC_DATADOG_SERVICE_NAME!,
        env: process.env.NEXT_PUBLIC_DATADOG_ENV!,
        // Set so Datadog can split RUM metrics by deploy. Vercel populates
        // NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA automatically on every build.
        version:
          process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || undefined,
        sessionSampleRate: 100,
        sessionReplaySampleRate: 100,
        trackUserInteractions: true,
        trackResources: true,
        trackLongTasks: true,
        profilingSampleRate: 100,
        // README §6.2: review per app. "mask-user-input" is the safer default
        // for anything handling form data; switch to "allow" only if you
        // explicitly need to capture input contents in session replays.
        defaultPrivacyLevel: "mask-user-input",
        allowedTracingUrls: buildAllowedTracingUrls(),
      });

      isInitialized = true;
      console.log("[Datadog] RUM initialized");
    } catch (error) {
      console.error("[Datadog] Failed to initialize RUM:", error);
    }
  })();

  return initializationPromise;
}

export function hasDatadogInitializationBeenAttempted(): boolean {
  return initializationAttempted;
}

/**
 * Submit a custom RUM action — equivalent to a product analytics event.
 * Fire-and-forget; safe to call before init completes.
 */
export async function submitDDEvent(
  event: string,
  context?: Record<string, unknown>,
): Promise<void> {
  await initializeDatadog();
  if (!isInitialized) return;
  const { datadogRum } = await import("@datadog/browser-rum");
  datadogRum.addAction(event, context);
}

/**
 * Set the current user on all subsequent RUM events.
 * Buffered: if RUM hasn't loaded yet, init runs first.
 */
export async function setDatadogUser(
  user: User & { id: string },
): Promise<void> {
  await initializeDatadog();
  if (!isInitialized) return;
  const { datadogRum } = await import("@datadog/browser-rum");
  datadogRum.setUser(user);
}

export async function clearDatadogUser(): Promise<void> {
  await initializeDatadog();
  if (!isInitialized) return;
  const { datadogRum } = await import("@datadog/browser-rum");
  datadogRum.clearUser();
}

/**
 * Triggers initialization without awaiting. Used by `<DatadogProvider />`.
 */
export function startDatadogInit(): void {
  void initializeDatadog();
}
