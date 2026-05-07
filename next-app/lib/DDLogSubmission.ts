/**
 * Server-side log shipping to Datadog Logs API v2.
 *
 * Pattern from project README §4.1:
 *   - Lazy singleton client (cold start friendly)
 *   - JSON-in-message so Datadog auto-extracts fields as facets
 *   - `ddsource: "nodejs"` so Datadog's Node processor recognizes the log
 *   - `ddtags: env:${NODE_ENV}` for free env filters
 *   - Dev fallback to `console.log` (no API calls, no rate limits)
 *   - Fire-and-forget — every caller should `void`-return, never await
 *
 * `@datadog/datadog-api-client` is listed in `serverExternalPackages` in
 * `next.config.ts` so Turbopack does not try to bundle its native deps.
 */

import { client, v2 } from "@datadog/datadog-api-client";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  message: string;
  level?: LogLevel;
  ddsource?: string;
  service?: string;
  hostname?: string;
  ddtags?: string;
  // Any additional fields are serialized into the `message` JSON.
  [key: string]: unknown;
}

const DEFAULT_SERVICE = "next-e2e-tracing";

let logsApi: v2.LogsApi | null = null;

function initializeDatadogClient(): v2.LogsApi | null {
  if (logsApi) return logsApi;

  const apiKey = process.env.DD_API_KEY;
  if (!apiKey) {
    console.warn(
      "[DDLogSubmission] DD_API_KEY is not set — logs will not ship",
    );
    return null;
  }

  const configuration = client.createConfiguration({
    authMethods: { apiKeyAuth: apiKey },
  });

  if (process.env.DATADOG_SITE) {
    client.setServerVariables(configuration, { site: process.env.DATADOG_SITE });
  }

  logsApi = new v2.LogsApi(configuration);
  return logsApi;
}

function buildLogItem(entry: LogEntry): {
  ddsource: string;
  service: string;
  hostname: string;
  message: string;
  ddtags: string;
} {
  const {
    message,
    level,
    // ddsource/service/hostname/ddtags are pulled out so they aren't
    // duplicated inside the serialized message body — they're already
    // top-level on HTTPLogItem.
    ddsource,
    service,
    hostname,
    ddtags,
    ...customFields
  } = entry;

  const dataToLog = {
    message,
    level: level || "info",
    ...customFields,
  };

  return {
    ddsource: ddsource || "nodejs",
    service: service || DEFAULT_SERVICE,
    hostname: hostname || process.env.HOSTNAME || "unknown",
    message: JSON.stringify(dataToLog),
    ddtags: ddtags || `env:${process.env.NODE_ENV || "production"}`,
  };
}

/**
 * Ship a single log entry to Datadog. Fire-and-forget; resolves whether or
 * not the upstream API succeeded so callers can safely `void`-return it.
 */
export async function submitLog(entry: LogEntry): Promise<void> {
  const isDevelopment = process.env.NODE_ENV === "development";
  const logEntry = buildLogItem(entry);

  if (isDevelopment) {
    console.log(logEntry.message);
    return;
  }

  const api = initializeDatadogClient();
  if (!api) return;

  try {
    await api.submitLog({
      body: [logEntry],
    });
  } catch (error) {
    console.error("[DDLogSubmission] Failed to submit log:", error);
  }
}

/**
 * Batched log submission. More efficient than calling `submitLog` in a loop.
 */
export async function submitLogs(entries: LogEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const isDevelopment = process.env.NODE_ENV === "development";
  const logItems = entries.map(buildLogItem);

  if (isDevelopment) {
    for (const item of logItems) console.log(item.message);
    return;
  }

  const api = initializeDatadogClient();
  if (!api) return;

  try {
    await api.submitLog({ body: logItems });
  } catch (error) {
    console.error("[DDLogSubmission] Failed to submit logs batch:", error);
  }
}

/**
 * Structured error helper — flattens Error.message/stack/name into the log.
 */
export async function logError(
  message: string,
  error: unknown,
  extra?: Record<string, unknown>,
): Promise<void> {
  const err = error instanceof Error
    ? {
        error_message: error.message,
        error_name: error.name,
        error_stack: error.stack,
      }
    : { error_message: String(error) };

  await submitLog({
    message,
    level: "error",
    ...err,
    ...extra,
  });
}

/**
 * Tool/operation timing helper. Use for "this thing took N ms" events.
 */
export async function logToolExecution(
  toolName: string,
  durationMs: number,
  extra?: Record<string, unknown>,
): Promise<void> {
  await submitLog({
    message: `tool_execution:${toolName}`,
    level: "info",
    tool: toolName,
    duration_ms: durationMs,
    ...extra,
  });
}
