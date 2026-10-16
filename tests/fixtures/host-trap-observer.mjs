// Test-only: count traps in the SDK worker, without recording guest data.
import { registerHooks } from 'node:module';
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.endsWith('/pkg/wasmer_sdk_js.js')) return result;
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString();
    return { ...result, source: `import { getEnvironmentData as trapTestData } from 'node:worker_threads';\n` + source.replace(
      'const obj = Object.create(Trap.prototype);',
      `const count = trapTestData('wasmdbox:host-traps');
        if (count && Atomics.add(new Int32Array(count), 0, 1) > 0) throw new Error('guest intercepted WASIX exit');
        const obj = Object.create(Trap.prototype);`,
    ) };
  },
});
