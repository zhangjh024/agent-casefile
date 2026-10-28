import type { AssertionResult, Casefile, Json, ReplayReport } from './types.js';
import { completeness, getPointer, validateCasefile } from './validation.js';
import {
  containsRedaction,
  jsonEqual,
  pointerTouchesMarker,
  redactionIntersects,
} from './privacy.js';
export function replayCasefile(c: Casefile): ReplayReport {
  const validation = validateCasefile(c);
  if (!validation.valid)
    throw new Error(
      'Cannot replay an invalid casefile. Run validate to inspect structural diagnostics.',
    );
  const diagnostics = validation.diagnostics;
  const partial = c.capture.status === 'partial' || c.capture.missing.length > 0;
  const assertions: AssertionResult[] = c.assertions.map((a, i) => {
    let status: AssertionResult['status'] = 'pass';
    let message = 'Recorded evidence satisfies the assertion.';
    const fail = (m: string) => {
      status = 'fail';
      message = m;
    };
    const unknown = (m: string) => {
      status = 'inconclusive';
      message = m;
    };
    switch (a.kind) {
      case 'event.exists': {
        if (!c.events.some((e) => e.kind === a.eventKind)) {
          if (partial) unknown('The event is absent, but the capture is partial.');
          else fail('No event of the expected kind was recorded.');
        }
        break;
      }
      case 'event.count': {
        const count = c.events.filter((e) => e.kind === a.eventKind).length;
        if (partial && count <= a.equals)
          unknown('Exact event counts cannot be confirmed from a partial capture.');
        else if (count !== a.equals)
          fail(`Expected ${a.equals} matching event(s); recorded ${count}.`);
        break;
      }
      case 'value.equals':
      case 'value.absent': {
        const index = c.events.findIndex((e) => e.id === a.eventId);
        const event = c.events[index]!;
        const found = getPointer(event, a.pointer);
        const pointer = `/events/${index}${a.pointer}`;
        if (
          redactionIntersects(c, pointer) ||
          pointerTouchesMarker(event, a.pointer) ||
          (a.kind === 'value.equals' &&
            (containsRedaction(a.expected) || redactionIntersects(c, `/assertions/${i}/expected`)))
        ) {
          unknown(
            'This assertion touches redacted evidence; it cannot establish equality or absence.',
          );
          break;
        }
        if (a.kind === 'value.absent') {
          if (found.found) fail('The field is present but was expected to be absent.');
        } else if (!found.found)
          fail('The asserted JSON pointer is not present in the recorded event.');
        else if (!jsonEqual(found.value as Json, a.expected))
          fail(
            'Recorded value differs from the expected value. Inspect locally; values are omitted from reports.',
          );
        break;
      }
      case 'calls.settled': {
        const events =
          a.boundary === 'all'
            ? c.events
            : c.events.filter((e) => e.kind.startsWith(a.boundary + '.') || e.kind === 'run.end');
        const issues = completeness({ ...c, events }).filter((d) => d.code.startsWith('boundary.'));
        if (issues.length) {
          if (partial) unknown('Missing or inconsistent boundary results in a partial capture.');
          else fail('One or more boundary calls lack exactly one correctly ordered result.');
        } else if (partial) unknown('All observed calls settled, but the capture is partial.');
        break;
      }
      case 'run.outcome': {
        const ends = c.events.filter((e) => e.kind === 'run.end');
        if (ends.length !== 1)
          unknown('Exactly one terminal run event is required to evaluate the outcome.');
        else if (ends[0]!.outcome !== a.equals)
          fail('Recorded terminal outcome differs from the expected outcome.');
        break;
      }
    }
    return { id: a.id, kind: a.kind, status, message };
  });
  const counts = { pass: 0, fail: 0, inconclusive: 0 };
  for (const a of assertions) counts[a.status]++;
  const status = counts.fail
    ? 'fail'
    : counts.inconclusive || diagnostics.length || !assertions.length
      ? 'inconclusive'
      : 'pass';
  return { mode: 'offline', casefileId: c.id, status, counts, assertions, diagnostics };
}
export interface CasefileComparison {
  mode: 'recording-comparison';
  before: ReplayReport;
  after: ReplayReport;
  assertionChanges: { id: string; before: string; after: string; definitionChanged: boolean }[];
  note: string;
}
export function compareCasefiles(before: Casefile, after: Casefile): CasefileComparison {
  const left = replayCasefile(before),
    right = replayCasefile(after);
  const ids = [
    ...new Set([...before.assertions.map((a) => a.id), ...after.assertions.map((a) => a.id)]),
  ];
  return {
    mode: 'recording-comparison',
    before: left,
    after: right,
    assertionChanges: ids.map((id) => {
      const a = before.assertions.find((a) => a.id === id),
        b = after.assertions.find((a) => a.id === id);
      return {
        id,
        before: left.assertions.find((a) => a.id === id)?.status ?? 'not-present',
        after: right.assertions.find((a) => a.id === id)?.status ?? 'not-present',
        definitionChanged: !a || !b || !jsonEqual(a as unknown as Json, b as unknown as Json),
      };
    }),
    note: 'This compares two recordings. It does not execute an agent, prove a code fix, or establish a causal root cause.',
  };
}
