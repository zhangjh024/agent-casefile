#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadCasefile, exportRegression, writePrivateNew } from './io.js';
import { redactCasefile } from './privacy.js';
import { replayCasefile, compareCasefiles } from './replay.js';
import { startInspector } from './server.js';
import type { Casefile, Diagnostic } from './types.js';
import { serializeCasefile } from './validation.js';
const HELP = `Agent Casefile 0.1.0 — recorded evidence, offline checks.

  casefile validate <file> [--json]
  casefile replay <file> [--json]
  casefile compare <before> <after> [--json]
  casefile redact <file> [--out <new-file>] [--pointer </path>] [--json]
  casefile export <file> --out <new-directory> [--pointer </path>] [--json]
  casefile inspect [file] [--port 4317]

Redact without --out previews locations, never raw values. Export is redacted by
 default and refuses overwrites. Review sensitive data before sharing.
Inspect binds 127.0.0.1 only. No model, network tool, or uploaded code is executed.
Exit: 0 pass/success, 1 assertion failure, 2 invalid input/error, 3 inconclusive.
`;
function diagnosticText(ds: Diagnostic[]): string {
  return ds
    .map((d) => `${d.severity.toUpperCase()} ${d.code} ${d.path || '/'}: ${d.message}`)
    .join('\n');
}
export async function main(argv = process.argv.slice(2)): Promise<number> {
  const command = argv.shift();
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return 0;
  }
  if (command === '--version') {
    console.log('0.1.0');
    return 0;
  }
  const allowed: Record<string, string[]> = {
    validate: ['--json'],
    replay: ['--json'],
    compare: ['--json'],
    redact: ['--json', '--out', '--pointer'],
    export: ['--json', '--out', '--pointer'],
    inspect: ['--port'],
  };
  if (!Object.hasOwn(allowed, command)) throw new Error('Unknown command. Run casefile --help.');
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    if (!allowed[command]!.includes(arg)) throw new Error('Unsupported option for this command.');
    if (arg !== '--pointer' && flags.has(arg)) throw new Error('Duplicate option.');
    let value = 'true';
    if (arg !== '--json') {
      value = argv[++i] ?? '';
      if (!value || value.startsWith('--')) throw new Error('Option requires a value.');
    }
    flags.set(arg, [...(flags.get(arg) ?? []), value]);
  }
  const json = flags.has('--json');
  const expect = command === 'compare' ? 2 : command === 'inspect' ? 0 : 1;
  if (positionals.length < expect || positionals.length > (command === 'inspect' ? 1 : expect))
    throw new Error('Unexpected or missing file argument. Run casefile --help.');
  const read = async (path: string): Promise<Casefile> => {
    const result = await loadCasefile(path);
    if (!result.valid) throw new Error('Invalid casefile.\n' + diagnosticText(result.diagnostics));
    return result.casefile!;
  };
  if (command === 'inspect') {
    const value = flags.get('--port')?.[0] ?? '4317';
    if (!/^\d+$/.test(value) || +value < 1 || +value > 65535)
      throw new Error('Port must be an integer between 1 and 65535.');
    await startInspector(positionals[0] ? await read(positionals[0]) : undefined, +value);
    console.log(
      `Inspector: http://127.0.0.1:${value}\nLocal, read-only, no telemetry. Loaded payloads can contain secrets; do not expose this port. Ctrl+C to stop.`,
    );
    return 0;
  }
  if (command === 'validate') {
    const result = await loadCasefile(positionals[0]!);
    if (json)
      console.log(
        JSON.stringify({ valid: result.valid, diagnostics: result.diagnostics }, null, 2),
      );
    else
      console.log(
        `${result.valid ? 'VALID' : 'INVALID'} schema${result.diagnostics.length ? '\n' + diagnosticText(result.diagnostics) : ' • no structural/completeness warnings'}`,
      );
    return result.valid ? 0 : 2;
  }
  const c = await read(positionals[0]!);
  if (command === 'replay') {
    const report = replayCasefile(c);
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(
        `OFFLINE ${report.status.toUpperCase()} • ${report.counts.pass} pass / ${report.counts.fail} fail / ${report.counts.inconclusive} inconclusive`,
      );
      for (const a of report.assertions)
        console.log(`  ${a.status.toUpperCase()} ${a.id}: ${a.message}`);
      if (report.diagnostics.length) console.log(diagnosticText(report.diagnostics));
      console.log('Checks recorded evidence only; no agent or tool was rerun.');
    }
    return report.status === 'pass' ? 0 : report.status === 'fail' ? 1 : 3;
  }
  if (command === 'compare') {
    const comparison = compareCasefiles(c, await read(positionals[1]!));
    if (json) console.log(JSON.stringify(comparison, null, 2));
    else {
      console.log(
        `${comparison.before.status.toUpperCase()} → ${comparison.after.status.toUpperCase()} (recordings only)`,
      );
      for (const a of comparison.assertionChanges)
        console.log(
          `  ${a.id}: ${a.before} → ${a.after}${a.definitionChanged ? ' [ASSERTION DEFINITION CHANGED]' : ''}`,
        );
      console.log(comparison.note);
    }
    return comparison.after.status === 'pass' ? 0 : comparison.after.status === 'fail' ? 1 : 3;
  }
  const pointers = flags.get('--pointer') ?? [];
  const out = flags.get('--out')?.[0];
  if (command === 'redact') {
    const result = redactCasefile(c, { pointers });
    if (out) {
      await writePrivateNew(resolve(out), serializeCasefile(result.casefile));
    }
    const summary = {
      mode: out ? 'redacted-file' : 'preview',
      findings: result.findings,
      count: result.findings.length,
      warning: 'Best-effort detection only. Manually review before sharing.',
    };
    if (json) console.log(JSON.stringify(summary, null, 2));
    else {
      console.log(
        `${summary.count} redaction location(s)${out ? '; new private output written' : ''}.`,
      );
      for (const f of result.findings) console.log(`  ${JSON.stringify(f.pointer)}: ${f.reason}`);
      console.log(summary.warning);
    }
    return 0;
  }
  if (!out) throw new Error('Export requires --out with a new directory path.');
  const result = await exportRegression(c, out, { pointers });
  if (json) console.log(JSON.stringify(result, null, 2));
  else
    console.log(
      `Exported ${result.files.length} files with ${result.redactions} redaction(s).\nRun: node --test ${JSON.stringify(result.directory + '/regression.test.mjs')}\nRedacted or incomplete assertions fail closed. Review casefile.json before sharing.`,
    );
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : 'Command failed.';
      console.error(
        process.argv.includes('--json')
          ? JSON.stringify({ error: message })
          : 'Error: ' +
              message.replace(
                /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,
                (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
              ),
      );
      process.exitCode = 2;
    });
}
