// How this process talks to the harness env (see env/src/wire.ts for the authoritative wire shape):
// bind some ephemeral port, hand that port to the env, then keep asking the env whether the trial is
// finished and leave with exit 0 once it says so. This file stays deliberately small — the scored
// behavior lives in the server app.ts builds, while the lifecycle itself belongs to the harness.
//
//   1. MAKEFUN_ENV_URL points at the env (http://store:8080 inside a trial container). With no
//      env URL set there is no one to register with, so the process exits 1 immediately.
//   2. Create the server and listen(0), letting the kernel hand out a free port. Port 8080 is the
//      env's own — never bind it.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The env remembers the caller's address together
//      with N as this entry's base URL and starts dialing it. Only the first register wins; a 409
//      says some other entry got there first, and this process just keeps waiting like anyone else.
//   4. GET $MAKEFUN_ENV_URL/done until the body reads {"done": true}. The env replies at once
//      ({"done": false} while the suite is still running), so this is a poll loop, not a held-open
//      request. A failed or slow poll is retried after a short exponential backoff; the process
//      never exits until the env reports done.
//   5. Close the server and exit 0. The harness then tears the env down, which writes the export
//      the scorer reads.
//
// main.ts imports only its own server: no package, no Node built-in, no model call.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** Paths on the env origin used by the lifecycle: register the port, then poll for done. */
const REGISTER_PATH = '/register';
const DONE_PATH = '/done';

/** How long one register or done request may take before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The first wait between retries, and the longest. */
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after `attempt` failed requests: exponential from RETRY_INITIAL_MS, capped. */
function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

/**
 * Sort a register response into what the caller should do with it: 'ok' accepts and moves on (200 is
 * the normal answer, 409 means the first register already won), 'fatal' is a contract error that ends
 * the program, and anything else is worth retrying because the env may still be starting.
 */
function classifyRegisterStatus(status: number): 'ok' | 'fatal' | 'retry' {
  if (status === 200 || status === 409) return 'ok';
  if (status === 400 || status === 405) return 'fatal';
  return 'retry';
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer; 409 means a first register
 * already won, which is not this process's to fix. 400 and 405 are contract errors and end the program;
 * a network error or another status is retried, since the env may still be starting.
 */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}${REGISTER_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const outcome = classifyRegisterStatus(res.status);
      if (outcome === 'ok') return;
      if (outcome === 'fatal') throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

/** Poll GET /done until it answers {"done":true}; never return before that. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}${DONE_PATH}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

/** Bound the port, register it, then wait for the env: the whole life of the process. */
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
