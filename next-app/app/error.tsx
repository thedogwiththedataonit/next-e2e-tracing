"use client";

import { useEffect } from "react";
import { addNextjsError } from "@datadog/browser-rum-nextjs";

export default function Error({
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
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 p-8 text-center">
      <h2 className="text-xl font-semibold">Something went wrong</h2>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        The error has been reported to Datadog.
      </p>
      <button
        onClick={reset}
        className="rounded-full border border-solid border-black dark:border-white transition-colors flex items-center justify-center hover:bg-gray-100 dark:hover:bg-gray-800 font-medium text-sm h-10 px-4"
      >
        Try again
      </button>
    </div>
  );
}
