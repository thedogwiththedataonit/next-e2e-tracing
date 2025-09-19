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
      args: ['-c', `DD_API_KEY=${ddApiKey} DD_SITE="datadoghq.com" DD_APM_ENABLED=true DD_ENV=dev bash -c "$(curl -L https://install.datadoghq.com/scripts/install_script_agent7.sh)"`],
      stderr: process.stderr,
      stdout: process.stdout,
      sudo: true,
    });

    if (datadogInstall.exitCode !== 0) {
      console.warn('Warning: Datadog agent installation script had issues, continuing...');
    }

    console.log('Checking if systemctl is available...');
    
    // Check if systemctl exists
    const checkSystemctl = await sandbox.runCommand({
      cmd: 'which',
      args: ['systemctl'],
      stderr: process.stderr,
      stdout: process.stdout,
    });

    if (checkSystemctl.exitCode === 0) {
      console.log('systemctl found, attempting to start Datadog agent...');
      
      // Try to start the agent with systemctl
      const startAgent = await sandbox.runCommand({
        cmd: 'sudo',
        args: ['systemctl', 'start', 'datadog-agent'],
        stderr: process.stderr,
        stdout: process.stdout,
      });

      // Wait 2 seconds as requested
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Check agent status
      const statusAgent = await sandbox.runCommand({
        cmd: 'sudo',
        args: ['systemctl', 'status', 'datadog-agent'],
        stderr: process.stderr,
        stdout: process.stdout,
      });
    } else {
      console.log('systemctl not found, checking for service command...');
      
      // Check if service command exists
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
        
        // Check if the agent binary exists
        const checkAgentBinary = await sandbox.runCommand({
          cmd: 'ls',
          args: ['-la', '/opt/datadog-agent/bin/agent'],
          stderr: process.stderr,
          stdout: process.stdout,
        });

        if (checkAgentBinary.exitCode === 0) {
          console.log('Datadog agent binary found, starting it directly...');
          
          // Start the agent in the background
          await sandbox.runCommand({
            cmd: 'bash',
            args: ['-c', 'nohup sudo /opt/datadog-agent/bin/agent run > /tmp/datadog-agent.log 2>&1 &'],
            stderr: process.stderr,
            stdout: process.stdout,
          });

          // Wait for agent to start
          await new Promise(resolve => setTimeout(resolve, 3000));

          // Check if agent is running
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
            
            // Check the log file
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
    // Note: We set DD_TRACE_LOG_STREAM_HANDLER=false to avoid ddtrace logging errors
    await sandbox.runCommand({
      cmd: 'bash',
      args: ['-c', `export DD_API_KEY=${ddApiKey} && export DD_SITE="datadoghq.com" && export DD_ENV=dev && export DD_SERVICE=flask-api && export DD_VERSION=1.0.0 && export DD_TRACE_PROPAGATION_STYLE=tracecontext && export DD_TRACE_LOG_STREAM_HANDLER=false && python /vercel/sandbox/flask-api/app.py`],
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
