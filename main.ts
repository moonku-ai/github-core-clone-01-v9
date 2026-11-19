// main.ts — the entrypoint: bind the forge's port, hand it to the harness env,
// then wait until the env says the trial is done.
//
// The lifecycle, step by step:
//   1. MAKEFUN_ENV_URL names the env (http://store:8080 inside a trial). Without
//      it there is nobody to register with, so the process exits 1 at once.
//   2. The server app.ts builds listens on an ephemeral port (the kernel picks
//      one; port 8080 belongs to the env itself, never bind it).
//   3. POST $MAKEFUN_ENV_URL/register with {"port": N}. The env records the
//      caller's address plus N as this entry's base URL and starts dialing it.
//      Only the first register wins: a 409 means another entry got there first,
//      and this process simply waits like everyone else.
//   4. GET $MAKEFUN_ENV_URL/done in a poll loop until the body reads
//      {"done": true}. The env answers at once ({"done": false} while the suite
//      still runs), so this is polling, not a held-open request. A failed or
//      slow poll is retried after a short exponential backoff; the process never
//      leaves until the env reports done.
//   5. Close the server and exit 0. The harness then tears the env down, which
//      writes the export the scorer reads.
//
// v9 serves HTTP from a hand-rolled parser on raw sockets (see app.ts); this
// file only owns the lifecycle, and imports nothing but its own server.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** The env paths this lifecycle uses: register the port, then poll for done. */
const REGISTER_PATH = '/register';
const DONE_PATH = '/done';

/** How long a single register or done request may run before it is abandoned. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The first pause between retries, and the longest pause allowed. */
const RETRY_FIRST_MS = 250;
const RETRY_MAX_MS = 2_000;
/** The doubling stops here, so the pause never grows past the cap by steps. */
const RETRY_MAX_DOUBLINGS = 8;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The pause after `attempt` failed requests: exponential from the first pause, capped. */
function retryDelay(attempt: number): number {
  const doublings = Math.min(attempt, RETRY_MAX_DOUBLINGS);
  return Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** doublings);
}

type RegisterOutcome = 'ok' | 'fatal' | 'retry';

/**
 * Sort a register response into what the caller should do with it. 200 is the
 * normal answer and 409 means the first register already won, so both move on;
 * 400 and 405 are contract errors that end the program; anything else is worth
 * retrying, since the env may still be starting.
 */
function registerOutcome(status: number): RegisterOutcome {
  if (status === 200 || status === 409) return 'ok';
  if (status === 400 || status === 405) return 'fatal';
  return 'retry';
}

/**
 * POST the bound port until the env accepts it. A network error or an
 * unexpected status is retried with backoff; a contract error throws.
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
      const outcome = registerOutcome(res.status);
      if (outcome === 'ok') return;
      if (outcome === 'fatal') throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
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

/** Bind the port, register it, then wait for the env: the whole life of the process. */
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
