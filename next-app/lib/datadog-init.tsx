"use client";

/**
 * Thin client-side wrappers around the Datadog Browser RUM SDK.
 *
 * Initialization itself lives in `instrumentation-client.ts` (run by Next.js
 * before React mounts), so these helpers can call the SDK synchronously and
 * trust that init has already happened.
 */

import { datadogRum } from "@datadog/browser-rum";
import type { User } from "@datadog/browser-rum";

/**
 * Submit a custom RUM action — equivalent to a product analytics event.
 */
export function submitDDEvent(
  event: string,
  context?: Record<string, unknown>,
): void {
  datadogRum.addAction(event, context);
}

/**
 * Set the current user on all subsequent RUM events.
 * `id` is required so RUM can attribute sessions to a stable user.
 */
export function setDatadogUser(user: User & { id: string }): void {
  datadogRum.setUser(user);
}

/**
 * Clear all user information from RUM events (call on logout).
 */
export function clearDatadogUser(): void {
  datadogRum.clearUser();
}
