'use client';

import { useState } from 'react';

import { submitDDEvent } from '@/lib/datadog-init';

export default function FlaskApiClient() {
  const [isFetchingData, setIsFetchingData] = useState(false);
  const [apiData, setApiData] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [callCount, setCallCount] = useState(0);

  const handleCallAPI = async () => {
    setIsFetchingData(true);
    setError(null);

    void submitDDEvent('flask_api_call_started');

    try {
      // Same-origin call to the Next.js proxy. The proxy reads `FLASK_API_URL`
      // from server env and fetches the Flask deployment, with `@vercel/otel`
      // auto-injecting the W3C `traceparent` header for cross-service trace
      // continuity.
      const response = await fetch('/api/call', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error || 'Failed to fetch data from Flask API');
      }

      const data = (await response.json()) as Record<string, unknown>;
      setApiData(data);
      setCallCount((prev) => prev + 1);
      void submitDDEvent('flask_api_call_succeeded', {
        call_index: callCount + 1,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An error occurred';
      setError(message);
      void submitDDEvent('flask_api_call_failed', { error: message });
    } finally {
      setIsFetchingData(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 items-center justify-center w-full max-w-2xl mx-auto p-8">
      <h1 className="text-2xl font-bold mb-4">Next.js + Flask E2E Tracing</h1>
      <p className="text-sm text-gray-600 dark:text-gray-400 text-center max-w-md">
        Click the button below to call the Flask API through the Next.js
        proxy. Browser RUM, the Next.js Vercel Function, and the Flask
        deployment will all share a single Datadog trace.
      </p>

      <button
        onClick={handleCallAPI}
        disabled={isFetchingData}
        className="rounded-full border border-solid border-transparent transition-colors flex items-center justify-center bg-foreground text-background gap-2 hover:bg-[#383838] dark:hover:bg-[#ccc] font-medium text-sm sm:text-base h-10 sm:h-12 px-4 sm:px-5 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isFetchingData ? 'Calling Flask API...' : 'Call Flask API'}
      </button>

      {callCount > 0 && (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          API called {callCount} time{callCount !== 1 ? 's' : ''}
        </p>
      )}

      {error && (
        <div className="mt-4 p-4 bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-100 rounded w-full">
          Error: {error}
        </div>
      )}

      {apiData && (
        <div className="mt-4 p-4 bg-gray-100 dark:bg-gray-800 rounded w-full">
          <h2 className="text-lg font-semibold mb-2">API Response:</h2>
          <pre className="overflow-auto text-sm">
            {JSON.stringify(apiData, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
