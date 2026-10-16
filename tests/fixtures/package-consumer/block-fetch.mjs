import { appendFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const report = process.env.WASMDBOX_VERIFY_FETCH_REPORT ?? process.env.WASMDBOX_PACKAGE_REPORT;
if (report) {
  // Instrument after the real guard runs, preserving its rejection behavior.
  // A preload assignment alone would be overwritten by the guard and hide calls.
  registerHooks({ load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.endsWith('/internal/package-fetch.js')) return result;
    return { ...result, source: `${result.source}\n
      import { appendFileSync as recordFetch } from 'node:fs';
      const guardedFetch = globalThis.fetch;
      globalThis.fetch = async (...args) => {
        const input = args[0];
        const url = input instanceof Request ? input.url : String(input);
        recordFetch(${JSON.stringify(report)}, JSON.stringify({ type: 'fetch', url }) + '\\n');
        return guardedFetch(...args);
      };
    ` };
  } });
  globalThis.fetch = async input => {
    const url = input instanceof Request ? input.url : String(input);
    appendFileSync(report, JSON.stringify({ type: 'fetch', url }) + '\n');
    throw new Error('Host fetch is forbidden during package verification');
  };
}
