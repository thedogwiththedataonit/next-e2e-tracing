import { NextResponse } from 'next/server';
import { Sandbox } from '@vercel/sandbox';
import ms from 'ms';

export async function POST() {
  try {
    // Get the Flask API GitHub repo URL from environment variable
    const githubRepoUrl = process.env.FLASK_API_GITHUB_REPO;
    const ddApiKey = process.env.DD_API_KEY;
    
    if (!githubRepoUrl) {
      return NextResponse.json(
        { error: 'FLASK_API_GITHUB_REPO environment variable is not set' },
        { status: 500 }
      );
    }

    if (!ddApiKey) {
      return NextResponse.json(
        { error: 'DD_API_KEY environment variable is not set' },
        { status: 500 }
      );
    }

    // Create a sandbox
    const sandbox = await Sandbox.create({
      source: {
        url: githubRepoUrl,
        type: 'git',
      },
      resources: { vcpus: 4 },
      timeout: ms('45m'), //5 hours
      ports: [5000], // Expose port 5000 for Flask API
      runtime: 'python3.13',
    });

    console.log('Sandbox created, installing Datadog agent...');

    // Install Datadog agent with environment variables
    const datadogInstall = await sandbox.runCommand({
      cmd: 'bash',
      args: ['-c', `DD_API_KEY=${ddApiKey} DD_SITE="datadoghq.com" DD_APM_INSTRUMENTATION_ENABLED=host DD_APM_INSTRUMENTATION_LIBRARIES=python:3,js:5 DD_PROFILING_ENABLED=auto DD_ENV=dev bash -c "$(curl -L https://install.datadoghq.com/scripts/install_script_agent7.sh)"`],
      stderr: process.stderr,
      stdout: process.stdout,
      sudo: true,
    });

    if (datadogInstall.exitCode !== 0) {
      console.warn('Warning: Datadog agent installation failed, continuing anyway...');
    } else {
      console.log('Datadog agent installed successfully');
    }

    console.log('Installing Python dependencies...');

    // Install Python dependencies from the flask-api directory
    const install = await sandbox.runCommand({
      cmd: 'pip',
      args: ['install', '-r', '/vercel/sandbox/flask-api/requirements.txt'],
      stderr: process.stderr,
      stdout: process.stdout,
    });

    if (install.exitCode !== 0) {
      await sandbox.stop();
      return NextResponse.json(
        { error: 'Failed to install Python dependencies' },
        { status: 500 }
      );
    }

    console.log('Dependencies installed, starting Flask server with Datadog APM...');

    // Export Datadog environment variables for the Flask app
    await sandbox.runCommand({
      cmd: 'bash',
      args: ['-c', `export DD_API_KEY=${ddApiKey} && export DD_SITE="datadoghq.com" && export DD_ENV=dev && export DD_SERVICE=flask-api && export DD_VERSION=1.0.0 && export DD_TRACE_PROPAGATION_STYLE=tracecontext && ddtrace-run python /vercel/sandbox/flask-api/app.py`],
      stderr: process.stderr,
      stdout: process.stdout,
      detached: true,
    });

    // Wait a moment for the server to start
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Get the public URL for port 5000
    const sandboxUrl = sandbox.domain(5000);

    console.log(`Flask API running at: ${sandboxUrl}`);

    return NextResponse.json({ 
      url: sandboxUrl
    });
  } catch (error) {
    console.error('Error creating sandbox:', error);
    return NextResponse.json(
      { error: 'Failed to create sandbox' },
      { status: 500 }
    );
  }
}
