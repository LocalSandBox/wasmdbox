import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [distribution] = process.argv.slice(2);
const { Sandbox } = await import(pathToFileURL(join(distribution, 'index.js')).href);
const sandbox = await Sandbox.create();
let observation;
const started = performance.now();
try {
  // This is the first command in a fresh sandbox: include cold command startup.
  const result = await sandbox.exec(['bash', '-c', 'sleep 1'], { timeoutMs: 20 });
  observation = { kind: 'completed', exitCode: result.exitCode, elapsedMs: performance.now() - started };
} catch (error) {
  observation = { kind: 'rejected', code: error.code, elapsedMs: performance.now() - started };
} finally {
  await sandbox.close();
}
console.log(JSON.stringify(observation));
