# RUM & Tracing Guide for Next.js Apps

> Battle-tested patterns extracted from the Brew codebase (Next.js 16 App Router + Vercel + Convex + Clerk) for instrumenting **Real User Monitoring (RUM)**, **server-side OpenTelemetry tracing**, and **structured log shipping** to Datadog.
>
> This guide is **framework-portable** — every pattern works in any Next.js 14+ App Router app on Vercel. Section 9 ("Lift-and-shift checklist") is the TL;DR for porting it to a new project.

---

## 1. What we instrument and why

There are **four independent layers** of observability in this app. Each can be adopted independently — they share env vars but have no code-level coupling.

| Layer | What it captures | Where it runs | Backed by |
|---|---|---|---|
| **1. Browser RUM** | Page loads, route changes, user actions, long tasks, JS errors, Core Web Vitals, session replay | Client (browser) | `@datadog/browser-rum` |
| **2. Server OTel traces** | HTTP request spans, `fetch` propagation, AI SDK tool calls, sub-spans | Server (Vercel Functions / Node) | `@vercel/otel` + `@opentelemetry/api` + AI SDK `experimental_telemetry` |
| **3. Structured server logs** | Custom JSON events (telemetry summaries, errors, business events) | Server | `@datadog/datadog-api-client` v2 Logs API |
| **4. App-level metrics aggregator** | Per-step / per-tool durations, token counts, agent run summaries | Server (in-process) | Custom `lib/telemetry.ts` tracker |

The "Vercel-native" layers (`@vercel/analytics` and `@vercel/speed-insights`) are added separately in `app/layout.tsx` and require zero config — they're not covered in depth here, but we recommend keeping them on.

```
┌────────────────────────────────────────────────────────────────────┐
│  Browser                                                           │
│  ┌────────────────────┐    ┌──────────────────────────────┐        │
│  │ DatadogInit        │───▶│ @datadog/browser-rum         │        │
│  │ (dynamic import)   │    │  • page views, route changes │        │
│  └────────────────────┘    │  • clicks, long tasks        │        │
│  ┌────────────────────┐    │  • session replay            │        │
│  │ DatadogUserSync    │───▶│  • setUser() from Clerk      │───┐    │
│  └────────────────────┘    └──────────────────────────────┘   │    │
│  ┌────────────────────┐                                       │    │
│  │ submitDDEvent()    │───▶ datadogRum.addAction()            │    │
│  └────────────────────┘                                       │    │
└────────────────────────────────────────────────────────│──────┼────┘
                                                         │      │
                       allowedTracingUrls: tracecontext ─┘      │
                       (W3C traceparent header on fetch)        │
                                                                ▼
┌────────────────────────────────────────────────────────────────────┐
│  Vercel Function (Node 24)                                         │
│  ┌────────────────────┐                                            │
│  │ instrumentation.ts │──▶ registerOTel({ serviceName })           │
│  └────────────────────┘    auto-instruments: fetch, http, AI SDK   │
│                            ▲                                       │
│                            │ traceparent continues from RUM        │
│                                                                    │
│  ┌────────────────────┐    ┌──────────────────────────────┐        │
│  │ AI SDK agent       │───▶│ experimental_telemetry: true │ ──┐    │
│  │ generate/stream    │    └──────────────────────────────┘   │    │
│  └────────────────────┘                                       │    │
│  ┌────────────────────┐    ┌──────────────────────────────┐   │    │
│  │ telemetryTracker   │───▶│ submitTelemetryLog()         │ ──┤    │
│  │ (custom, in-mem)   │    └──────────────────────────────┘   │    │
│  └────────────────────┘                                       │    │
│  ┌────────────────────┐                                       │    │
│  │ submitLog() /      │──▶ Datadog Logs v2 API (HTTP)         │    │
│  │ logError()         │                                       │    │
│  └────────────────────┘                                       │    │
└────────────────────────────────────────────────────────────────┼───┘
                                                                ▼
                                                       Datadog Cloud
                                  (RUM + APM traces + Logs joined by user/trace_id)
```

---

## 2. Packages and environment variables

### 2.1 Packages (`package.json`)

```json
{
  "dependencies": {
    "@datadog/browser-rum": "^6.24.0",
    "@datadog/datadog-api-client": "^1.51.0",
    "@vercel/otel": "^2.1.0",
    "@opentelemetry/api": "^1.9.0",
    "@opentelemetry/api-logs": "^0.207.0",
    "@opentelemetry/instrumentation": "^0.207.0",
    "@opentelemetry/sdk-logs": "^0.207.0"
  }
}
```

> The four `@opentelemetry/*` peer dependencies are **required** for `@vercel/otel` to load — install them or `pnpm add` will succeed but `registerOTel()` will throw at boot. The `@datadog/browser-rum-react` package is also installed in this repo but currently unused; skip it unless you adopt the React Router integration.

### 2.2 Environment variables

| Var | Side | Purpose | Required |
|---|---|---|---|
| `NEXT_PUBLIC_DATADOG_APPLICATION_ID` | client | RUM application ID | yes (RUM) |
| `NEXT_PUBLIC_DATADOG_CLIENT_TOKEN` | client | RUM client token | yes (RUM) |
| `NEXT_PUBLIC_DATADOG_SERVICE_NAME` | client | Service tag in RUM | yes (RUM) |
| `NEXT_PUBLIC_DATADOG_ENV` | client | `prod` / `staging` / `dev` | yes (RUM) |
| `DD_API_KEY` | server | Datadog Logs API key | yes (server logs) |
| `DATADOG_SITE` | server | e.g. `datadoghq.com`, `datadoghq.eu` | optional, defaults to `datadoghq.com` |
| `NODE_ENV` | both | Used to skip RUM/log shipping in `development` | implicit |

> **Critical**: only the four `NEXT_PUBLIC_DATADOG_*` vars get inlined into the client bundle. The server-side `DD_API_KEY` must **never** be `NEXT_PUBLIC_*` — it would leak via the bundle. We also enforce this at the firewall: `DD_API_KEY` is only used in modules under `lib/` that are imported from server entrypoints (API routes, server actions, `instrumentation.ts`).

### 2.3 `next.config.ts`

The Datadog Node API client uses native bindings via `node-fetch`/`undici` and **must not be bundled** by Turbopack/Webpack:

```47:51:next.config.ts
  serverExternalPackages: [
    "@resvg/resvg-js",
    "@datadog/datadog-api-client",
    "sharp",
  ],
```

Forgetting this causes opaque runtime errors in production along the lines of `Cannot find module './lib/...'` deep inside the Datadog client.

---

## 3. Server-side: OpenTelemetry via `@vercel/otel`

### 3.1 The instrumentation file

Next.js looks for an `instrumentation.ts` (or `.js`) file at the **project root** (sibling of `app/`) and runs `register()` exactly once when the runtime boots — both for serverless functions and for the dev server.

```1:8:instrumentation.ts
import { registerOTel } from "@vercel/otel";

export function register() {
  registerOTel({
    serviceName: "brew-agent",
  });
}
```

That's the entire setup. `@vercel/otel`:

- Configures a `NodeSDK` with sane defaults.
- Auto-instruments `fetch` and `http` so every outbound request gets a child span.
- Attaches the service name to all spans (matched against the `service` field in Datadog).
- Honors the `OTEL_*` env vars Vercel injects automatically (no manual exporter config required when deployed on Vercel — traces are forwarded through the Vercel observability bridge).
- When the [Datadog Vercel integration](https://vercel.com/integrations/datadog) is installed on the project, traces flow into Datadog APM with no further work and are automatically joined to RUM sessions via `traceparent`.

> **Don't reinvent this.** Don't add `@opentelemetry/sdk-node` and a manual `BatchSpanProcessor` — `@vercel/otel` handles the runtime detection (Node vs Edge) and prevents the common pitfall of creating two SDK instances inside HMR.

### 3.2 AI SDK auto-tracing

Any call to the Vercel AI SDK (`generateText`, `streamText`, `ToolLoopAgent`, etc.) inherits the trace if you set `experimental_telemetry: { isEnabled: true }`:

```619:628:lib/agents/unified-email-agent-v2.ts
    stopWhen: stepCountIs(10),
    experimental_telemetry: {
      isEnabled: true,
      functionId: "brewAgentV2",
      metadata: {
        modelId,
        isReasoningEnabled,
        architecture: "intelligent-context",
      },
    },
```

Each tool call becomes a child span named `ai.toolCall <toolName>`, with `functionId` and `metadata.*` attached as span attributes. This gives you a flame graph per agent run for free.

### 3.3 Trace propagation client → server

The browser RUM SDK injects a W3C `traceparent` header on `fetch`/XHR calls whose URL matches `allowedTracingUrls`:

```92:96:lib/datadog-init.tsx
        // Specify URLs to propagate trace headers for connection between RUM and backend trace
        allowedTracingUrls: [
          { match: "https://brew.new/", propagatorTypes: ["tracecontext"] },
        ],
```

`@vercel/otel` reads `traceparent` on the server side, so the resulting backend span becomes the **child** of the RUM resource span. In Datadog you can click a slow XHR in a RUM session and jump straight into the matching APM trace.

> **Always include your production origin(s)** in `allowedTracingUrls`. Don't use `match: "*"` — it leaks trace IDs to third-party domains. For multi-tenant or preview-URL apps, use a regex predicate (`match: (url) => url.startsWith(window.location.origin)`).

---

## 4. Server-side: structured logs to Datadog Logs API

OTel spans are great for "what happened in this request". For "what happened in this **business operation**" (a chat completion, a screenshot batch, etc.) we ship structured JSON logs through `@datadog/datadog-api-client`.

### 4.1 The log submission service

`lib/DDLogSubmission.ts` is the single entry point for all server logging. It is **fire-and-forget by design**:

```73:137:lib/DDLogSubmission.ts
export async function submitLog(entry: LogEntry): Promise<void> {
  const isDevelopment = process.env.NODE_ENV === "development";

  // Extract metadata fields
  const {
    message,
    level,
    ddsource,
    service,
    hostname,
    ddtags,
    ...customFields
  } = entry;

  // Build the complete data object
  const dataToLog = {
    message: message,
    ...customFields,
  };

  // Build log entry with JSON in message field
  const logEntry = {
    ddsource: ddsource || "nodejs",
    service: service || "brew-email-agent",
    hostname: hostname || process.env.HOSTNAME || "unknown",
    message: JSON.stringify(dataToLog), // All data as JSON string in message
    ddtags: ddtags || `env:${process.env.NODE_ENV || "production"}`,
  };

  // Development: Log raw JSON
  if (isDevelopment) {
    console.log(logEntry.message); // Just the message field (which contains all data)
    return;
  }
```

Key design rules to **preserve** in any port:

1. **Lazy singleton** — `initializeDatadogClient()` is called only on first log to keep cold start fast.
2. **JSON-in-message** — every custom field is serialized into `message` so Datadog's "Log Explorer" parses it as facets automatically. No custom log pipeline required.
3. **`ddsource: "nodejs"`** — required for Datadog's Node.js processor to recognize the log.
4. **`ddtags: env:${NODE_ENV}`** — gives you free `env:prod` / `env:dev` filters in Datadog.
5. **Dev-mode fallback to `console.log`** — keeps local development fast and quiet (no API calls, no rate limits).
6. **`void` + `.catch()` everywhere** — never `await` log submission in a hot path. The Vercel function should return to the user even if Datadog is down.

### 4.2 Helper APIs

```typescript
import { submitLog, submitLogs, logError, logToolExecution } from "@/lib/DDLogSubmission";

// Single log
void submitLog({
  message: "Order placed",
  level: "info",
  orderId,
  userId,
  total_cents: 1299,
});

// Batched (more efficient when emitting >1 log per request)
void submitLogs(events.map((e) => ({ message: "event", ...e })));

// Structured error helper - flattens Error.message/stack/name
void logError("Order placement failed", err, { orderId, userId });

// Tool/operation timing helper
void logToolExecution("createImage", durationMs, { model: "flux-pro" });
```

### 4.3 Specialized telemetry log

Because agent telemetry has a fixed schema, `submitTelemetryLog()` adds an extra `source` tag for easier filtering in Datadog:

```222:243:lib/DDLogSubmission.ts
export async function submitTelemetryLog(
  telemetry: TelemetryLogEntry,
  source: "streaming" | "generate" = "generate",
): Promise<void> {
  const isDevelopment = process.env.NODE_ENV === "development";

  // Build the telemetry data object (all fields we want in the message)
  const telemetryData = {
    ...telemetry,
    source: source,
  };

  // Build log entry with JSON in message field
  const logEntry = {
    ddsource: telemetry.ddsource || "nodejs",
    service: telemetry.service || "brew-email-agent",
    hostname: process.env.HOSTNAME || "unknown",
    message: JSON.stringify(telemetryData), // All telemetry data as JSON string
    ddtags:
      telemetry.ddtags ||
      `env:${process.env.NODE_ENV || "production"},source:${source},model:${telemetry.model || "unknown"}`,
  };
```

In Datadog you can then build dashboards filtered by `source:streaming model:anthropic/claude-4.5-sonnet`.

---

## 5. Server-side: in-process telemetry tracker

OTel gives you per-span timing, but for **business-meaningful** aggregations (e.g. "average `createImage` duration in this generation") we maintain a tiny pure-JS tracker in `lib/telemetry.ts`.

### 5.1 The tracker shape

```40:65:lib/telemetry.ts
export function createTelemetryTracker(options: {
  modelId: string;
  userId?: string;
  chatId?: string;
}) {
  const telemetry: GenerationTelemetry = {
    startTime: Date.now(),
    modelId: options.modelId,
    userId: options.userId,
    chatId: options.chatId,
    steps: [],
  };

  return {
    /**
     * Start tracking a new step
     */
    startStep(stepIndex: number) {
      const step: StepTiming = {
        stepIndex,
        startTime: Date.now(),
        toolTimings: [],
      };
      telemetry.currentStep = step;
      telemetry.steps.push(step);
    },
```

Usage pattern (synchronous path, `lib/email-generation.ts`):

```typescript
const tracker = createTelemetryTracker({ modelId, userId, chatId });

const result = await agent.generate({ messages });

result.steps.forEach((step, i) => {
  tracker.startStep(i);
  step.toolCalls?.forEach((tc) => {
    tracker.startTool(tc.toolName);
    tracker.endTool(tc.toolName);
  });
  tracker.endStep();
});

const final = tracker.complete();
const metrics = await logTelemetry(final); // returns Datadog-shaped metrics
```

For the **streaming** path (`app/api/chat/route.ts`) we can't iterate `result.steps` — instead a `TransformStream` wraps the SSE response and parses `tool-input-available` / `tool-output-available` events as they fly past. See lines `~1500-1680` of `app/api/chat/route.ts` for the full pattern, and Section 8 below for guidance on whether you actually need this.

### 5.2 Aggregation

`logTelemetry()` produces both per-tool entries and rolled-up `tool_stats` (count, avg, min, max) so dashboards don't need to recompute them:

```217:253:lib/telemetry.ts
function aggregateToolStats(telemetry: GenerationTelemetry) {
  const stats: Record<
    string,
    {
      count: number;
      total_ms: number;
      avg_ms: number;
      min_ms: number;
      max_ms: number;
    }
  > = {};

  telemetry.steps.forEach((step) => {
    step.toolTimings.forEach((tool) => {
      if (!tool.durationMs) return;

      if (!stats[tool.toolName]) {
        stats[tool.toolName] = {
          count: 0,
          total_ms: 0,
          avg_ms: 0,
          min_ms: Infinity,
          max_ms: 0,
        };
      }

      const s = stats[tool.toolName];
      s.count++;
      s.total_ms += tool.durationMs;
      s.min_ms = Math.min(s.min_ms, tool.durationMs);
      s.max_ms = Math.max(s.max_ms, tool.durationMs);
      s.avg_ms = s.total_ms / s.count;
    });
  });

  return stats;
}
```

---

## 6. Client-side: Datadog Browser RUM

This is the most performance-sensitive layer. **Doing it wrong will block your initial paint.** The pattern below is non-blocking, idempotent across React strict-mode re-mounts, and free of race conditions.

### 6.1 The init module — `lib/datadog-init.tsx`

Five rules, all visible in the file:

| Rule | Why |
|---|---|
| **Dynamic `import()` inside an async function** | Removes the ~50KB SDK from the initial JS bundle. The SDK loads in parallel with the rest of the app. |
| **Module-level `isInitialized` + `initializationPromise` flags** | Prevents double-init under React strict mode and concurrent `useEffect` runs. |
| **Skip in `NODE_ENV === "development"`** | Avoids polluting production analytics from local sessions. |
| **Hard-fail closed when env vars are missing** | Logs a warning but does not throw — the app must keep working. |
| **All public APIs are `async` + fire-and-forget** | Callers `void`-return, never block on RUM. |

```28:96:lib/datadog-init.tsx
async function initializeDatadog() {
  // Return early if already initialized
  if (isInitialized) {
    console.log("[Datadog] Already initialized, skipping");
    return;
  }

  // If initialization is in progress, wait for it
  if (initializationPromise) {
    console.log("[Datadog] Initialization in progress, waiting...");
    return initializationPromise;
  }

  // Mark that we've attempted initialization
  initializationAttempted = true;

  // Skip initialization in development to avoid polluting analytics
  if (process.env.NODE_ENV === "development") {
    console.log("[Datadog] Initialization skipped in development mode");
    return;
  }

  // Validate environment variables
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

  console.log("[Datadog] Starting initialization...");

  // Create initialization promise for concurrent calls
  initializationPromise = (async () => {
    try {
      // Dynamic import - loads Datadog SDK asynchronously without blocking
      const { datadogRum } = await import("@datadog/browser-rum");

      datadogRum.init({
        applicationId: process.env.NEXT_PUBLIC_DATADOG_APPLICATION_ID!,
        clientToken: process.env.NEXT_PUBLIC_DATADOG_CLIENT_TOKEN!,
        site: "datadoghq.com",
        service: process.env.NEXT_PUBLIC_DATADOG_SERVICE_NAME!,
        env: process.env.NEXT_PUBLIC_DATADOG_ENV!,
        // Specify a version number to identify the deployed version of your application in Datadog
        // version: '1.0.0',
        sessionSampleRate: 100,
        sessionReplaySampleRate: 100,
        trackUserInteractions: true,
        trackResources: true,
        profilingSampleRate: 100,
        trackLongTasks: true,
        defaultPrivacyLevel: "allow",
        // Specify URLs to propagate trace headers for connection between RUM and backend trace
        allowedTracingUrls: [
          { match: "https://brew.new/", propagatorTypes: ["tracecontext"] },
        ],
      });
```

### 6.2 The init configuration knobs you'll actually tune

| Option | This app | What it does |
|---|---|---|
| `sessionSampleRate` | `100` | % of sessions that send any RUM data. Lower in high-traffic apps to control billing. |
| `sessionReplaySampleRate` | `100` | % of sampled sessions that record video-like replays. Heavy — drop to `5–10` past 100k MAU. |
| `profilingSampleRate` | `100` | % of sampled sessions that record JS CPU profiles. Drop to `1–5` in very high traffic. |
| `trackUserInteractions` | `true` | Auto-records click events with selectors. Almost always on. |
| `trackResources` | `true` | Captures network requests as `resource` events (xhr, fetch, img, css, js). Required for trace propagation. |
| `trackLongTasks` | `true` | Captures the Long Tasks API events (>50ms blocks). |
| `defaultPrivacyLevel` | `"allow"` | Captures input values verbatim. Set to `"mask-user-input"` (or `"mask"`) if you have PII in form fields. **Review this for every new app.** |
| `allowedTracingUrls` | prod origin | URLs that get a `traceparent` header. **Never** `*`. |

> Always set `version` (e.g. from `process.env.VERCEL_GIT_COMMIT_SHA`) so RUM can split metrics by deploy. We left it commented out in this repo as a known TODO.

### 6.3 The mount point — `components/providers.tsx`

`<DatadogInit />` is mounted **once** in the root client provider tree. It returns `null`; its only job is to fire the async init from a `useEffect`.

```13:34:components/providers.tsx
export const Providers = ({ children }: { children: React.ReactNode }) => {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <NextThemesProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange={false}
      >
        <ClerkThemeProvider>
          <DatadogInit />
          <DatadogUserSync />
          <MixpanelInit />
          <MixpanelUserSync />
          <GtagSignupConversion />
          {children}
        </ClerkThemeProvider>
      </NextThemesProvider>
    </QueryClientProvider>
  );
};
```

The provider itself sits inside `app/layout.tsx`, wrapped by a `<Suspense>` so the rest of the app can still SSR while the bundle loads.

### 6.4 User attribution — `components/datadog-user-sync.tsx`

Without user context, every RUM event is anonymous. We bridge **Clerk → Datadog** in a tiny component:

```17:58:components/datadog-user-sync.tsx
export default function DatadogUserSync() {
  const { user, isLoaded } = useUser();

  useEffect(() => {
    // Don't do anything until Clerk has loaded
    if (!isLoaded) {
      console.log("[DatadogUserSync] Waiting for Clerk to load...");
      return;
    }

    // Fire-and-forget pattern - runs in parallel without blocking
    if (user) {
      console.log(
        "[DatadogUserSync] User detected, setting Datadog user context:",
        {
          id: user.id,
          email: user.primaryEmailAddress?.emailAddress,
          name: user.fullName || user.username,
        },
      );

      // User is signed in - set user context in Datadog (async, non-blocking)
      void setDatadogUser({
        id: user.id,
        user_uuid: user.id,
        email: user.primaryEmailAddress?.emailAddress,
        name: user.fullName || user.username || undefined,
      }).catch((error) => {
        console.error("[DatadogUserSync] Failed to set Datadog user:", error);
      });
    } else {
      console.log(
        "[DatadogUserSync] No user detected, clearing Datadog user context",
      );

      // User is signed out - clear user context (async, non-blocking)
      void clearDatadogUser().catch((error) => {
        console.error("[DatadogUserSync] Failed to clear Datadog user:", error);
      });
    }
  }, [user, isLoaded]);

  return null;
}
```

The `setDatadogUser` / `clearDatadogUser` helpers in `lib/datadog-init.tsx` await `initializeDatadog()` first, so the user context is buffered and applied as soon as the SDK finishes loading even if Clerk reports a logged-in user before RUM is ready.

> The same pattern works with **NextAuth, Auth0, Supabase** — replace `useUser()` and pass whatever stable identifier (and email/name) you have. `id` should be the **stable internal user ID**, not an email.

### 6.5 Custom events — `submitDDEvent()`

For product analytics-style events ("user clicked Add Group"):

```13:21:components/header/sections/emails-page-header.tsx
  const handleAddGroup = async () => {
    if (!userId) {
      appToast.error("You must be signed in to add groups");
      return;
    }

    const randomSuffix = Math.random().toString(36).slice(2, 7);
    const newGroupName = `Group ${randomSuffix}`;
```

```30:35:components/header/sections/emails-page-header.tsx
      if (response._metadata) {
        submitDDEvent("group_added", {
          ...response._metadata,
          initial_position: 0,
        });
      }
```

`submitDDEvent` (`lib/datadog-init.tsx`) calls `datadogRum.addAction()` under the hood — these show up as **custom actions** in RUM and are queryable by attribute. Always pass a stable `event` name (snake_case, no PII) and put dimensions in the payload.

---

## 7. End-to-end request example

Here's what an instrumented "user sends a chat message" looks like:

```
1. Browser
   - User clicks "Send"
   - submitDDEvent("chat_message_sent", { chat_id, model_id })
       → datadogRum.addAction (visible in RUM "Actions")
   - fetch("/api/chat", { … })
       → RUM creates a "resource" event
       → @datadog/browser-rum injects traceparent: 00-<trace-id>-<span-id>-01

2. Vercel Function
   - instrumentation.ts already booted on cold start
   - @vercel/otel reads traceparent → continues the trace
   - app/api/chat/route.ts:
       - submitLog({ message: "Chat API: Latest user message", … })
           → Datadog Logs (queryable in Log Explorer)
       - createTelemetryTracker({ modelId, userId, chatId })
       - agent.generate({ … })  ← experimental_telemetry creates child spans
                                   per tool call (fetchBrand, createImage, …)
       - On stream complete (in TransformStream.flush):
           submitTelemetryLog({
             model, total_duration_ms, tool_count, tools_used, …toolDurations
           }, "streaming")

3. Datadog
   - RUM session shows the click + the XHR + Web Vitals
   - Click into the XHR → jump to the APM trace
   - Trace shows: ai.streamText > ai.toolCall fetchBrand > ai.toolCall createImage
   - Logs view shows the structured telemetry summary, joined to the trace
     by trace_id and to the user by usr.id
```

---

## 8. Pitfalls and gotchas

1. **Edge runtime** — `@vercel/otel` v2 supports both Node and Edge, but `@datadog/datadog-api-client` is **Node-only**. Don't import `lib/DDLogSubmission.ts` from a route or middleware that opts into the edge runtime (`export const runtime = "edge"`). Use OTel events for edge work.
2. **`maxDuration` and async logging** — Vercel Functions terminate at `maxDuration`. A `void submitLog(...)` started just before the return *may* be cut off. For critical events use `after()` from `next/server` to extend execution past response close.
3. **RUM in `<Suspense>`** — `<DatadogInit />` must be inside a client boundary (`"use client"`). It's currently nested under `<ClerkThemeProvider>` which is itself client. Keep this invariant if you reorganize providers.
4. **Don't double-init OTel** — never combine `@vercel/otel` with a manual `NodeSDK` — they fight over the global tracer provider and you'll silently lose spans.
5. **Don't `console.log` huge objects in prod** — the `submitLog()` JSON-in-message pattern can blow past Datadog's 1MB/log limit if you spread an entire AI response into one log. Truncate or pick fields.
6. **Streaming telemetry parsing is fragile** — the `TransformStream` in `app/api/chat/route.ts` parses SSE chunks with regex. If you change the AI SDK protocol or stream format, this silently stops capturing per-tool timings (but won't crash). Prefer `experimental_telemetry` + APM spans whenever possible — fall back to the regex parser only when you also need an aggregated summary log.
7. **Sample rates compound** — `sessionReplaySampleRate` is a percentage of `sessionSampleRate`, not of all sessions. With `sessionSampleRate: 50, sessionReplaySampleRate: 50`, you record replays for 25% of all sessions.
8. **`defaultPrivacyLevel: "allow"`** records form inputs verbatim, including credit cards and passwords if they're not properly masked at the field level. **Review for every app** and consider `"mask-user-input"` as the safe default for any product handling sensitive data.

---

## 9. Lift-and-shift checklist for a new Next.js app

Follow these in order. Estimated total time: **30 min** for a fresh project.

### Step 1 — Install packages

```bash
pnpm add @vercel/otel @datadog/browser-rum @datadog/datadog-api-client \
         @opentelemetry/api @opentelemetry/api-logs \
         @opentelemetry/instrumentation @opentelemetry/sdk-logs
```

### Step 2 — Set env vars (Vercel project settings or `.env.local`)

```bash
# Client (RUM)
NEXT_PUBLIC_DATADOG_APPLICATION_ID=...
NEXT_PUBLIC_DATADOG_CLIENT_TOKEN=...
NEXT_PUBLIC_DATADOG_SERVICE_NAME=my-app
NEXT_PUBLIC_DATADOG_ENV=prod

# Server (Logs API)
DD_API_KEY=...
```

### Step 3 — Update `next.config.ts`

Add the Datadog Node client to `serverExternalPackages`:

```ts
const nextConfig: NextConfig = {
  serverExternalPackages: ["@datadog/datadog-api-client"],
};
```

### Step 4 — Create `instrumentation.ts` at the project root

```ts
// instrumentation.ts (sibling of app/, NOT inside app/)
import { registerOTel } from "@vercel/otel";

export function register() {
  registerOTel({ serviceName: "my-app" });
}
```

### Step 5 — Copy `lib/datadog-init.tsx` and `components/datadog-user-sync.tsx`

Take them verbatim from this repo and adjust:

- `allowedTracingUrls` → your production origin(s).
- `defaultPrivacyLevel` → `"mask-user-input"` if you handle PII.
- `<DatadogUserSync />` → swap `useUser()` from Clerk for your auth provider's hook.
- Add `version: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA` to the `datadogRum.init({ … })` call to get per-deploy splits.

### Step 6 — Copy `lib/DDLogSubmission.ts`

Take it verbatim. Optionally rename `service` defaults from `"brew-email-agent"` to your service name.

### Step 7 — Copy `lib/telemetry.ts` (if you have AI/long-running operations)

Otherwise skip — for plain CRUD apps, OTel auto-instrumentation + `submitLog()` is enough.

### Step 8 — Wire up the providers

In your root client provider component (or directly in `app/layout.tsx` if you don't have one):

```tsx
"use client";
import DatadogInit from "@/lib/datadog-init";
import DatadogUserSync from "@/components/datadog-user-sync";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <YourAuthProvider>
      <DatadogInit />
      <DatadogUserSync />
      {children}
    </YourAuthProvider>
  );
}
```

### Step 9 — (Optional but recommended) Add Vercel-native monitoring

In `app/layout.tsx`:

```tsx
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";

// inside <body>
<SpeedInsights />
<Analytics />
```

These give you Web Vitals and traffic analytics in Vercel without any Datadog config.

### Step 10 — Install the Datadog Vercel integration

In your Vercel project: **Integrations → Browse Marketplace → Datadog**. This auto-forwards Vercel function logs and OTel traces into Datadog APM, which makes the trace propagation set up in Step 5 actually useful end-to-end.

### Step 11 — Verify

Deploy to a Vercel preview, then in Datadog:

1. **RUM → Sessions** — should see your test session within ~30s.
2. **APM → Services** — should see your `serviceName` listed.
3. Click an XHR in a RUM session → should jump into the corresponding APM trace.
4. **Logs → Live Tail** — emit a test `submitLog({ message: "hello" })` from a route handler.

If any of these are missing, check the browser console for `[Datadog]` warnings (RUM logs everything it skips and why) and the Vercel function logs for `[DDLogSubmission]` warnings (server logs DD_API_KEY issues).

---

## 10. Reference files (in this repo)

| File | Role |
|---|---|
| `instrumentation.ts` | OTel registration |
| `next.config.ts` | `serverExternalPackages` config |
| `lib/datadog-init.tsx` | Browser RUM init + `submitDDEvent` / `setDatadogUser` / `clearDatadogUser` |
| `lib/DDLogSubmission.ts` | Server log shipping (`submitLog`, `submitLogs`, `submitTelemetryLog`, `logError`, `logToolExecution`) |
| `lib/telemetry.ts` | In-process per-step / per-tool timing tracker for AI agent runs |
| `components/datadog-user-sync.tsx` | Bridges Clerk user → RUM `setUser()` |
| `components/providers.tsx` | Mounts `<DatadogInit />` + `<DatadogUserSync />` |
| `app/layout.tsx` | Vercel `<Analytics />` + `<SpeedInsights />` |
| `app/api/chat/route.ts` (lines ~1500-1680) | Streaming telemetry pattern via `TransformStream` |
| `lib/email-generation.ts` | Non-streaming telemetry pattern (iterate `result.steps`) |
| `lib/agents/unified-email-agent-v2.ts` | AI SDK `experimental_telemetry` example |
| `docs/TELEMETRY.md` | Operator-facing doc on the email agent telemetry |

---

## 11. Further reading

- [`@vercel/otel` docs](https://vercel.com/docs/observability/otel-overview) — runtime detection, env vars, exporter behavior on Vercel.
- [Datadog RUM Browser SDK](https://docs.datadoghq.com/real_user_monitoring/browser/) — every init option, including the `beforeSend` hook for last-mile redaction.
- [Datadog Logs Node API client](https://github.com/DataDog/datadog-api-client-typescript) — pagination, batch limits, retry behavior.
- [AI SDK Telemetry](https://ai-sdk.dev/docs/ai-sdk-core/telemetry) — `experimental_telemetry` field semantics, span attributes.
- [W3C Trace Context](https://www.w3.org/TR/trace-context/) — the `traceparent` format used by `allowedTracingUrls`.
