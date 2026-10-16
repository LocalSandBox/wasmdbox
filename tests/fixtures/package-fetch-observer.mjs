import { registerHooks } from 'node:module';
import './package-consumer/block-fetch.mjs';

// Model a host preload that completely replaces fetch, including in workers.
globalThis.fetch = async () => new Response('host replacement');
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.endsWith('/internal/sandbox-worker.js') && !url.endsWith('/wasmer-sdk/dist/node-worker.js')) return result;
  // Probe at worker entry, after all preloads, rather than during this preload.
  return { ...result, source: `
    import { appendFileSync as recordGuard } from 'node:fs';
    import { threadId as guardThreadId } from 'node:worker_threads';
    let guardBlocked = false;
    try { await fetch('data:text/plain,unexpected'); }
    catch (error) { guardBlocked = /Host package downloads are disabled/.test(error.message); }
    recordGuard(process.env.WASMDBOX_FETCH_GUARD_REPORT, JSON.stringify({ threadId: guardThreadId, blocked: guardBlocked }) + '\\n');
    ${result.source}
  ` };
} });
