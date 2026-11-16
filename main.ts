/**
 * GitHub Core Clone - Production Server Entrypoint
 * Engineered for maximum conformance, high throughput, and robust lifecycle management.
 * Optimized with high-efficiency exponential backoff and reliable teardown.
 */

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (!ENV_URL) {
  process.stderr.write('[github-core-clone] FATAL: MAKEFUN_ENV_URL is not configured\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_INITIAL_MS = 200;
const RETRY_MAX_MS = 1_500;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function calculateBackoff(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * Math.pow(1.8, Math.min(attempt, 6)));
}

async function registerServer(port: number): Promise<void> {
  let attempt = 0;
  while (true) {
    try {
      const response = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (response.status === 200 || response.status === 409) {
        return;
      }

      if (response.status === 400 || response.status === 405) {
        const text = await response.text();
        throw new Error(`Register failed with HTTP ${response.status}: ${text}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Register failed with HTTP ')) {
        throw err;
      }
    }

    await delay(calculateBackoff(attempt++));
  }
}

async function pollUntilCompleted(): Promise<void> {
  let attempt = 0;
  while (true) {
    try {
      const res = await fetch(`${ENV_URL}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.ok) {
        const payload = (await res.json()) as { done?: boolean };
        if (payload?.done === true) {
          return;
        }
      }
    } catch {
      // Suite is executing test workload, continue polling
    }

    await delay(calculateBackoff(attempt++));
  }
}

async function bootstrap(): Promise<void> {
  const server = createApp();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('TCP server failed to bind ephemeral socket');
  }

  process.stdout.write(`[github-core-clone] Forge server listening on port ${addr.port}\n`);

  await registerServer(addr.port);
  process.stdout.write('[github-core-clone] Registration confirmed with test harness\n');

  await pollUntilCompleted();

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });

  process.stdout.write('[github-core-clone] Workload complete, server exited cleanly\n');
}

try {
  await bootstrap();
  process.exit(0);
} catch (error) {
  process.stderr.write(`[github-core-clone] Unhandled exception: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
