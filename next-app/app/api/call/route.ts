import { NextRequest, NextResponse } from 'next/server';

import { logError, submitLog } from '@/lib/DDLogSubmission';

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  let sandboxUrl: string | undefined;

  try {
    const body = (await request.json()) as { sandboxUrl?: string };
    sandboxUrl = body.sandboxUrl;

    if (!sandboxUrl) {
      return NextResponse.json(
        { error: 'sandboxUrl is required' },
        { status: 400 }
      );
    }

    // `@vercel/otel` auto-instruments fetch — this call automatically
    // gets a child span and propagates the W3C `traceparent` header,
    // which the Flask sandbox accepts via DD_TRACE_PROPAGATION_STYLE=tracecontext.
    const response = await fetch(`${sandboxUrl}/api/data`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      void logError(
        'sandbox_call_upstream_error',
        new Error(`Upstream returned ${response.status}`),
        {
          sandbox_url: sandboxUrl,
          upstream_status: response.status,
          duration_ms: Date.now() - startedAt,
        },
      );
      throw new Error(`Failed to fetch from sandbox: ${response.statusText}`);
    }

    const data = await response.json();

    void submitLog({
      message: 'sandbox_call',
      level: 'info',
      sandbox_url: sandboxUrl,
      upstream_status: response.status,
      duration_ms: Date.now() - startedAt,
    });

    return NextResponse.json(data);
  } catch (error) {
    console.error('Error calling sandbox API:', error);
    void logError('sandbox_call_failed', error, {
      sandbox_url: sandboxUrl,
      duration_ms: Date.now() - startedAt,
    });
    return NextResponse.json(
      { error: 'Failed to fetch data from sandbox' },
      { status: 500 }
    );
  }
}
