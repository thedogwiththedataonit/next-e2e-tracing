import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const { sandboxUrl } = await request.json();
    
    if (!sandboxUrl) {
      return NextResponse.json(
        { error: 'sandboxUrl is required' },
        { status: 400 }
      );
    }

    // Make a fetch call to the sandbox URL at /api/data
    const response = await fetch(`${sandboxUrl}/api/data`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch from sandbox: ${response.statusText}`);
    }

    const data = await response.json();
    
    return NextResponse.json(data);
  } catch (error) {
    console.error('Error calling sandbox API:', error);
    return NextResponse.json(
      { error: 'Failed to fetch data from sandbox' },
      { status: 500 }
    );
  }
}
