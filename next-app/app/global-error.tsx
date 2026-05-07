"use client";

import { useEffect } from "react";
import { addNextjsError } from "@datadog/browser-rum-nextjs";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    addNextjsError(error);
  }, [error]);

  return (
    <html>
      <body>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "60vh",
            gap: "1rem",
            padding: "2rem",
            textAlign: "center",
            fontFamily: "system-ui, sans-serif",
          }}
        >
          <h2 style={{ fontSize: "1.25rem", fontWeight: 600 }}>
            Something went wrong
          </h2>
          <p style={{ fontSize: "0.875rem", color: "#666" }}>
            The error has been reported to Datadog.
          </p>
          <button
            onClick={reset}
            style={{
              borderRadius: "9999px",
              border: "1px solid currentColor",
              padding: "0.5rem 1rem",
              fontSize: "0.875rem",
              cursor: "pointer",
              background: "transparent",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
