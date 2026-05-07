"use client";

import { useEffect } from "react";

import { startDatadogInit } from "@/lib/datadog-init";

/**
 * Mounts the Datadog Browser RUM SDK once at the root of the client tree.
 *
 * The init logic itself lives in `lib/datadog-init.tsx` and is idempotent,
 * so this component is safe to render even under React strict-mode double
 * effect invocations.
 */
export default function DatadogProvider(): null {
  useEffect(() => {
    startDatadogInit();
  }, []);

  return null;
}
