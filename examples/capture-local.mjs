#!/usr/bin/env node
/**
 * Capture a fresh run of an original, local demonstration application.
 * There is no network call, provider SDK, timer-based timeout, or third-party repro.
 */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRecorder, replayCasefile, serializeCasefile } from '../dist/index.js';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--fixed') || args.length > 1) {
  console.error('Usage: node examples/capture-local.mjs [--fixed]');
  process.exitCode = 2;
} else {
  const fixed = args.includes('--fixed');
  const output = resolve(`capture-${fixed ? 'fixed' : 'broken'}.local.casefile.json`);
  const recorder = createRecorder({
    id: `local-recovery-${fixed ? 'fixed' : 'broken'}`,
    title: `Local demo: ${fixed ? 'recovery reaches a terminal UI state' : 'recovery leaves the UI running'}`,
    description:
      'A fresh capture of this repository-owned local demo application. No external model or tool is called.',
    environment: { runtime: `Node.js ${process.version}` },
    provenance: {
      kind: 'recorded',
      source: 'examples/capture-local.mjs',
      notes:
        'Actual local function execution with synthetic inputs. The tool deliberately throws a named TimeoutError; no real timeout or upstream SDK reproduction is claimed.',
    },
    assertions: [
      { id: 'boundaries-settled', kind: 'calls.settled', boundary: 'all' },
      { id: 'run-records-error', kind: 'run.outcome', equals: 'error' },
    ],
  });

  const ui = { toolState: 'running', message: '' };
  await recorder.model({ prompt: 'Find the status of a fictional support ticket.' }, async () => ({
    toolCall: { name: 'lookup_ticket', ticketId: 'TICKET-DEMO-42' },
  }));

  try {
    await recorder.tool('lookup_ticket', { ticketId: 'TICKET-DEMO-42' }, async () => {
      const error = new Error('Deliberately thrown by the local demo handler.');
      error.name = 'TimeoutError';
      throw error;
    });
  } catch {
    ui.message = 'Lookup failed. Please try again.';
    // The example bug: the recovery branch forgets to transition the UI state.
    if (fixed) ui.toolState = 'error';
  }

  const casefile = recorder.finish('error', { ui });
  const finalEvent = casefile.events.at(-1);
  casefile.assertions.push({
    id: 'ui-stops-spinning',
    kind: 'value.equals',
    eventId: finalEvent.id,
    pointer: '/data/ui/toolState',
    expected: 'error',
    description: 'A failed lookup must leave a terminal UI state.',
  });

  try {
    // Local captures are private by default and existing evidence is never overwritten.
    await writeFile(output, serializeCasefile(casefile), { flag: 'wx', mode: 0o600 });
    const report = replayCasefile(casefile);
    console.log(`Fresh local capture: ${output}`);
    console.log(
      `Offline assertions: ${report.status} (${report.counts.pass} pass, ${report.counts.fail} fail, ${report.counts.inconclusive} inconclusive)`,
    );
    console.log('This exercised the local demo handler only, not a live model or external tool.');
    process.exitCode = report.status === 'pass' ? 0 : report.status === 'fail' ? 1 : 3;
  } catch {
    console.error(
      'Could not write the capture. The output may already exist; it was not overwritten.',
    );
    process.exitCode = 2;
  }
}
