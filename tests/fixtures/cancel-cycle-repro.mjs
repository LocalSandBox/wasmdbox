import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Sandbox } from 'wasmdbox';

const root = await mkdtemp(join(tmpdir(), 'wasmdbox-cancel-stress-'));
const box = await Sandbox.create({ mounts: [{ hostPath: root, guestPath: '/mounted' }] });
const results = [];
const rounds = Number(process.argv[2] ?? 20);
assert.ok(Number.isInteger(rounds) && rounds > 0 && rounds <= 100);
await mkdir('.artifacts', { recursive: true });
try {
  const guest = 'const fs = require("fs"); fs.appendFileSync("/mounted/ticks", process.env.ROUND + "\\n"); setInterval(() => fs.appendFileSync("/mounted/ticks", "tick\\n"), 50);';
  let previous = '';
  for (let round = 0; round < rounds; round++) {
    const abort = new AbortController();
    const started = Date.now();
    const command = box.exec(['node', '-e', guest], { signal: abort.signal, env: { ROUND: String(round) } });
    let completed;
    void command.then(value => { completed = { value }; }, error => { completed = { error: { code: error.code, message: error.message } }; });
    let written = false;
    while (Date.now() - started < 30000) {
      try { if (await readFile(join(root, 'ticks'), 'utf8') !== previous) { written = true; break; } }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (completed) throw new Error(`round ${round} ended before writing: ${JSON.stringify(completed)}`);
      await delay(10);
    }
    results.push({ round, wrote: written, ms: Date.now() - started, completed });
    await writeFile('.artifacts/cancel-cycle-results.json', JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results.at(-1)));
    assert.ok(written, `round ${round} stalled after previous cancellation`);
    abort.abort();
    await assert.rejects(command, { code: 'ABORTED' });
    previous = await readFile(join(root, 'ticks'), 'utf8');
    await delay(150);
    assert.equal(await readFile(join(root, 'ticks'), 'utf8'), previous);
  }
} finally {
  try { await box.close(); }
  finally { await rm(root, { recursive: true, force: true }); }
}
