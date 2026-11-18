// Process entrypoint for the forge.
//
// This file carries no business logic. Its whole job is the harness
// lifecycle: boot the HTTP app on an ephemeral port, tell the supervising
// environment where to reach us, then stay alive until that environment
// reports the run is finished.

import { createApp } from './app.ts';
import type { Server } from 'node:http';

const REQUEST_TIMEOUT_MS = 30_000;
const BACKOFF_START_MS = 250;
const BACKOFF_LIMIT_MS = 2_000;

/** Wait time for a retry round: starts at 250ms, doubles, never exceeds 2s. */
function backoffMs(round: number): number {
  const grown = BACKOFF_START_MS * 2 ** Math.min(round, 8);
  return Math.min(BACKOFF_LIMIT_MS, grown);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Base URL of the supervising environment, with any trailing slashes cut. */
function envBaseUrl(): string {
  const raw = process.env.MAKEFUN_ENV_URL ?? '';
  return raw.replace(/\/+$/, '');
}

/** Bind the server to a kernel-picked port and resolve with that port. */
function bindEphemeral(server: Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('server did not bind to a TCP port'));
        return;
      }
      resolve(addr.port);
    });
  });
}

/**
 * Announce our port to the environment.
 *
 * A 200 means the registration landed. A 409 means another process got
 * there first, which is not an error for us. A 400 or 405 means we broke
 * the protocol, so those abort the process. Anything else — a network
 * failure, a timeout, an unexpected status — is retried with backoff.
 */
async function announcePort(base: string, port: number): Promise<void> {
  for (let round = 0; ; round += 1) {
    try {
      const res = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) {
        return;
      }
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register rejected with status ${res.status}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register rejected')) {
        throw err;
      }
      // Network trouble: fall through and retry after a pause.
    }
    await pause(backoffMs(round));
  }
}

/** Poll the environment until it answers that the run is done. */
async function awaitCompletion(base: string): Promise<void> {
  for (let round = 0; ; round += 1) {
    try {
      const res = await fetch(`${base}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) {
        const payload = (await res.json()) as { done?: unknown };
        if (payload.done === true) {
          return;
        }
      }
    } catch {
      // Unreachable or timed out: that means "not done", so keep polling.
    }
    await pause(backoffMs(round));
  }
}

async function run(): Promise<void> {
  const base = envBaseUrl();
  if (base === '') {
    process.stderr.write('MAKEFUN_ENV_URL is not set; nowhere to register this process.\n');
    process.exit(1);
  }

  const server = createApp();
  const port = await bindEphemeral(server);
  process.stdout.write(`forge listening on port ${port}\n`);

  await announcePort(base, port);
  await awaitCompletion(base);

  server.close();
  process.stdout.write('environment reported done; shutting down\n');
}

run().then(
  () => {
    process.exit(0);
  },
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`fatal: ${message}\n`);
    process.exit(1);
  },
);
