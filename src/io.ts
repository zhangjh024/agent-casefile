import { open, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { Casefile, ValidationResult } from './types.js';
import { MAX_BYTES, parseCasefile, serializeCasefile } from './validation.js';
import { redactCasefile } from './privacy.js';
export const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
export async function loadCasefile(path: string): Promise<ValidationResult> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Input must be a regular file.');
    if (stat.size > MAX_BYTES) throw new Error('Casefiles are limited to 5 MiB.');
    // Read a bounded buffer even if another process grows the file after stat().
    const data = Buffer.alloc(MAX_BYTES + 1);
    let count = 0;
    while (count < data.length) {
      const result = await file.read(data, count, data.length - count, null);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    if (count > MAX_BYTES) throw new Error('Casefiles are limited to 5 MiB.');
    return parseCasefile(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, count)));
  } finally {
    await file.close();
  }
}
export async function writePrivateNew(path: string, content: string): Promise<void> {
  await writeFile(path, content, { flag: 'wx', mode: 0o600 });
}
const RUNNER = `import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseCasefile, replayCasefile } from './lib/index.js';
const validation = parseCasefile(await readFile(new URL('./casefile.json', import.meta.url), 'utf8'));
test('casefile structure is valid', () => assert.equal(validation.valid, true, 'Invalid casefile structure.'));
if (validation.valid) {
  const report = replayCasefile(validation.casefile);
  test('recording is complete and all checks pass', () => assert.equal(report.status, 'pass', 'Offline recording status: ' + report.status + '. This is not a live agent rerun.'));
  for (const result of report.assertions) {
    test(result.id, () => assert.equal(result.status, 'pass', result.message));
  }
}
`;
export async function exportRegression(
  c: Casefile,
  destination: string,
  options: { pointers?: string[] } = {},
): Promise<{ directory: string; redactions: number; files: string[] }> {
  const redacted = redactCasefile(c, options);
  const directory = resolve(destination);
  const contents = new Map<string, string>();
  contents.set('casefile.json', serializeCasefile(redacted.casefile));
  contents.set('regression.test.mjs', RUNNER);
  contents.set(
    'package.json',
    JSON.stringify(
      {
        private: true,
        type: 'module',
        scripts: { test: 'node --test regression.test.mjs' },
        engines: { node: '>=22.18' },
      },
      null,
      2,
    ) + '\n',
  );
  contents.set(
    'README.md',
    `# Offline regression artifact\n\nRun \`node --test regression.test.mjs\` with Node.js 22.18+. No installation, API key, or network is needed.\n\nThis checks the bundled recorded evidence, not a new agent implementation. Failing assertions and inconclusive/redacted evidence fail closed. A passing artifact is not proof that a software bug was fixed. To compare a changed implementation, capture its new boundaries with the same assertion definitions and inspect that new recording.\n\nCasefile data was processed with best-effort redaction. Review it manually before sharing; detection cannot guarantee removal of all sensitive content. No uploaded code is executed.\n`,
  );
  for (const name of [
    'index.js',
    'types.js',
    'validation.js',
    'privacy.js',
    'replay.js',
    'recorder.js',
  ])
    contents.set('lib/' + name, await readFile(new URL(name, import.meta.url), 'utf8'));
  contents.set('LICENSE', await readFile(join(PACKAGE_ROOT, 'LICENSE'), 'utf8'));
  const hashes = Object.fromEntries(
    [...contents].map(([name, content]) => [
      name,
      createHash('sha256').update(content).digest('hex'),
    ]),
  );
  contents.set(
    'manifest.json',
    JSON.stringify(
      {
        format: 'agent-casefile-regression',
        version: '1.0',
        hashAlgorithm: 'sha256',
        files: hashes,
      },
      null,
      2,
    ) + '\n',
  );
  // Exclusive creation refuses existing directories, symlinks, and overwrites.
  await mkdir(directory, { mode: 0o700 });
  await mkdir(join(directory, 'lib'), { mode: 0o700 });
  for (const [name, content] of contents) await writePrivateNew(join(directory, name), content);
  return { directory, redactions: redacted.findings.length, files: [...contents.keys()] };
}
