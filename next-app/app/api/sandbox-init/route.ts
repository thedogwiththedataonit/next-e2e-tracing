import { NextResponse } from 'next/server';
import { Sandbox } from '@vercel/sandbox';
import ms from 'ms';

import { logError, submitLog } from '@/lib/DDLogSubmission';

export async function POST() {
  const startedAt = Date.now();

  try {
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

    const sandbox = await Sandbox.create({
      source: {
        url: githubRepoUrl,
        type: 'git',
      },
      resources: { vcpus: 4 },
      timeout: ms('45m'),
      ports: [5000],
      runtime: 'python3.13',
    });

    console.log('Sandbox created, installing Datadog agent...');

    const datadogInstall = await sandbox.runCommand({
      cmd: 'bash',
      args: ['-c', `DD_API_KEY=${ddApiKey} DD_SITE="datadoghq.com" DD_APM_ENABLED=true DD_ENV=dev bash -c "$(curl -L https://install.datadoghq.com/scripts/install_script_agent7.sh)"`],
      stderr: process.stderr,
      stdout: process.stdout,
      sudo: true,
    });

    if (datadogInstall.exitCode !== 0) {
      console.warn('Warning: Datadog agent installation script had issues, continuing...');
    }

    console.log('Checking if systemctl is available...');

    const checkSystemctl = await sandbox.runCommand({
      cmd: 'which',
      args: ['systemctl'],
      stderr: process.stderr,
      stdout: process.stdout,
    });

    if (checkSystemctl.exitCode === 0) {
      console.log('systemctl found, attempting to start Datadog agent...');

      await sandbox.runCommand({
        cmd: 'sudo',
        args: ['systemctl', 'start', 'datadog-agent'],
        stderr: process.stderr,
        stdout: process.stdout,
      });

      await new Promise(resolve => setTimeout(resolve, 2000));

      await sandbox.runCommand({
        cmd: 'sudo',
        args: ['systemctl', 'status', 'datadog-agent'],
        stderr: process.stderr,
        stdout: process.stdout,
      });
    } else {
      console.log('systemctl not found, checking for service command...');

      const checkService = await sandbox.runCommand({
        cmd: 'which',
        args: ['service'],
        stderr: process.stderr,
        stdout: process.stdout,
      });

      if (checkService.exitCode === 0) {
        console.log('service command found, trying to install it properly...');
      } else {
        console.log('No init system found, trying direct agent execution...');

        const checkAgentBinary = await sandbox.runCommand({
          cmd: 'ls',
          args: ['-la', '/opt/datadog-agent/bin/agent'],
          stderr: process.stderr,
          stdout: process.stdout,
        });

        if (checkAgentBinary.exitCode === 0) {
          console.log('Datadog agent binary found, starting it directly...');

          await sandbox.runCommand({
            cmd: 'bash',
            args: ['-c', 'nohup sudo /opt/datadog-agent/bin/agent run > /tmp/datadog-agent.log 2>&1 &'],
            stderr: process.stderr,
            stdout: process.stdout,
          });

          await new Promise(resolve => setTimeout(resolve, 3000));

          const checkProcess = await sandbox.runCommand({
            cmd: 'bash',
            args: ['-c', 'ps aux | grep -v grep | grep datadog-agent'],
            stderr: process.stderr,
            stdout: process.stdout,
          });

          if (checkProcess.exitCode === 0) {
            console.log('Datadog agent process is running');
          } else {
            console.log('Datadog agent process not found, checking logs...');

            await sandbox.runCommand({
              cmd: 'tail',
              args: ['-20', '/tmp/datadog-agent.log'],
              stderr: process.stderr,
              stdout: process.stdout,
            });
          }
        } else {
          console.log('Datadog agent binary not found at expected location');
        }
      }
    }

    console.log('Installing Python dependencies...');

    const install = await sandbox.runCommand({
      cmd: 'pip',
      args: ['install', '-r', '/vercel/sandbox/flask-api/requirements.txt'],
      stderr: process.stderr,
      stdout: process.stdout,
    });

    if (install.exitCode !== 0) {
      await sandbox.stop();
      void logError('sandbox_init_failed', new Error('pip install failed'), {
        sandbox_id: sandbox.sandboxId,
        duration_ms: Date.now() - startedAt,
      });
      return NextResponse.json(
        { error: 'Failed to install Python dependencies' },
        { status: 500 }
      );
    }

    console.log('Dependencies installed, starting Flask server with Datadog APM...');

    // DD_TRACE_PROPAGATION_STYLE=tracecontext is what makes the W3C
    // `traceparent` header injected by `@vercel/otel` (auto-instrumented
    // `fetch` in /api/call) actually link into the Flask span tree.
    await sandbox.runCommand({
      cmd: 'bash',
      args: ['-c', `export DD_API_KEY=${ddApiKey} && export DD_SITE="datadoghq.com" && export DD_ENV=dev && export DD_SERVICE=flask-api && export DD_VERSION=1.0.0 && export DD_TRACE_PROPAGATION_STYLE=tracecontext && export DD_TRACE_LOG_STREAM_HANDLER=false && python /vercel/sandbox/flask-api/app.py`],
      stderr: process.stderr,
      stdout: process.stdout,
      detached: true,
    });

    await new Promise(resolve => setTimeout(resolve, 2000));

    const sandboxUrl = sandbox.domain(5000);

    console.log(`Flask API running at: ${sandboxUrl}`);

    void submitLog({
      message: 'sandbox_initialized',
      level: 'info',
      sandbox_id: sandbox.sandboxId,
      sandbox_url: sandboxUrl,
      duration_ms: Date.now() - startedAt,
    });

    return NextResponse.json({
      url: sandboxUrl,
    });
  } catch (error) {
    console.error('Error creating sandbox:', error);
    void logError('sandbox_init_failed', error, {
      duration_ms: Date.now() - startedAt,
    });
    return NextResponse.json(
      { error: 'Failed to create sandbox' },
      { status: 500 }
    );
  }
}
