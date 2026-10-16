import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Sandbox } from 'wasmdbox';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

for (const commandBytes of [1024 * 1024, 2 * 1024 * 1024]) {
  test(`bash -c transports a ${commandBytes}-byte UTF-8 heredoc intact`, { timeout: 120_000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'wasmdbox-large-argv-'));
    let box;
    t.after(async () => {
      try { await box?.close(); }
      finally { await rm(root, { recursive: true, force: true }); }
    });
    const prefix = "cat > /workspace/large.txt <<'LITERAL_PAYLOAD'\n";
    const suffix = 'LITERAL_PAYLOAD\n';
    const line = '中文 多行 café 🐚 \' " \\ $HOME `echo no` $(echo no) & | ; < >\n';
    const size = commandBytes - Buffer.byteLength(prefix + suffix);
    const repeated = line.repeat(Math.floor((size - 1) / Buffer.byteLength(line)));
    const expected = Buffer.from(repeated + 'x'.repeat(size - Buffer.byteLength(repeated) - 1) + '\n');
    const command = prefix + expected.toString() + suffix;
    assert.equal(Buffer.byteLength(command), commandBytes);
    box = await Sandbox.create({ network: false, signal: t.signal, startupTimeoutMs: 60_000,
      mounts: [{ hostPath: root, guestPath: '/workspace' }],
    });
    const result = await box.exec(['bash', '-c', command], { check: true, signal: t.signal, timeoutMs: 30_000, outputBytes: 1024 });
    assert.equal(result.exitCode, 0);
    const actual = await readFile(join(root, 'large.txt'));
    assert.equal(actual.length, expected.length);
    assert.equal(digest(actual), digest(expected));
    assert.equal((await box.exec(['pwd'], { check: true, timeoutMs: 10_000, signal: t.signal })).stdout, '/workspace\n');
    t.diagnostic(JSON.stringify({ commandBytes, fileBytes: actual.length, sha256: digest(actual) }));
  });
}
