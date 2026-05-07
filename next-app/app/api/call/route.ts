import { NextResponse } from 'next/server';

import { logError, submitLog } from '@/lib/DDLogSubmission';

/**
 * Server-to-server call into the Flask API project.
 *
 * `FLASK_API_URL` is the production Flask deployment (set per-environment in
 * the Next.js Vercel project's env vars). `@vercel/otel` auto-instruments
 * `fetch`, so this call automatically gets a child span and propagates the
 * W3C `traceparent` header — the Flask side picks it up via
 * `DD_TRACE_PROPAGATION_STYLE=tracecontext`, joining both services into a
 * single Datadog APM trace that links back to the originating RUM session.
 */
export async function POST() {
  const startedAt = Date.now();
  const flaskApiUrl = process.env.FLASK_API_URL?.replace(/\/$/, '');

  if (!flaskApiUrl) {
    return NextResponse.json(
      {
        error:
          'FLASK_API_URL is not set. Configure it in the Next.js Vercel project (or .env.local) to point at the deployed Flask API.',
      },
      { status: 500 },
    );
  }

  try {
    const response = await fetch(`${flaskApiUrl}/api/data`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      void logError(
        'flask_api_upstream_error',
        new Error(`Upstream returned ${response.status}`),
        {
          flask_api_url: flaskApiUrl,
          upstream_status: response.status,
          duration_ms: Date.now() - startedAt,
        },
      );
      return NextResponse.json(
        { error: `Flask upstream returned ${response.status}` },
        { status: 502 },
      );
    }

    const data = await response.json();

    void submitLog({
      message: 'flask_api_call',
      level: 'info',
      flask_api_url: flaskApiUrl,
      upstream_status: response.status,
      duration_ms: Date.now() - startedAt,
    });

    return NextResponse.json(data);
  } catch (error) {
    console.error('Error calling Flask API:', error);
    void logError('flask_api_call_failed', error, {
      flask_api_url: flaskApiUrl,
      duration_ms: Date.now() - startedAt,
    });
    return NextResponse.json(
      { error: 'Failed to fetch data from Flask API' },
      { status: 500 },
    );
  }
}
