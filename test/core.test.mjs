import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  serializeCasefile,
  MAX_BYTES,
  REDACTED,
  parseCasefile,
  validateCasefile,
  replayCasefile,
  privacyFindings,
  redactCasefile,
  compareCasefiles,
  getPointer,
  pointerParts,
} from '../dist/index.js';

const clone = (value) => structuredClone(value);
const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../examples/${name}.casefile.json`, import.meta.url), 'utf8'));
function minimal(data = {}) {
  return {
    format: 'agent-casefile',
    version: '1.0',
    id: 'test-case',
    title: 'Original test case',
    createdAt: '2026-01-15T12:00:00.000Z',
    provenance: { kind: 'synthetic' },
    environment: { runtime: 'node:test' },
    capture: { status: 'complete', missing: [] },
    events: [{ id: 'end', kind: 'run.end', atMs: 0, outcome: 'success', data }],
    assertions: [{ id: 'outcome', kind: 'run.outcome', equals: 'success' }],
  };
}
const valueAssertion = (pointer, expected) => ({
  id: 'value',
  kind: 'value.equals',
  eventId: 'end',
  pointer,
  expected,
});
const absentAssertion = (pointer) => ({
  id: 'absent',
  kind: 'value.absent',
  eventId: 'end',
  pointer,
});

for (const [name, expected] of [
  ['tool-timeout', 'fail'],
  ['tool-timeout-fixed', 'pass'],
  ['error-shape', 'fail'],
  ['incomplete', 'inconclusive'],
]) {
  test(`original ${name} fixture validates and reports ${expected}`, () => {
    const input = fixture(name),
      result = validateCasefile(input);
    assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
    assert.equal(input.provenance.kind, 'synthetic');
    assert.equal(replayCasefile(input).status, expected);
  });
}

test('the main failure is the named UI assertion, not a generic failure', () => {
  const report = replayCasefile(fixture('tool-timeout'));
  assert.deepEqual(report.counts, { pass: 4, fail: 1, inconclusive: 0 });
  assert.equal(report.assertions.find((a) => a.status === 'fail').id, 'ui-stops-spinning');
});

const malformed = [
  ['unsupported version', (c) => (c.version = '2.0')],
  ['unknown root property', (c) => (c.runCode = 'process.exit(0)')],
  ['unknown nested property', (c) => (c.environment.command = 'echo invalid')],
  ['unknown event property', (c) => (c.events[0].shell = 'echo invalid')],
  ['unknown assertion kind', (c) => (c.assertions[0].kind = 'javascript')],
  ['duplicate event IDs', (c) => c.events.push({ ...clone(c.events[0]) })],
  ['duplicate assertion IDs', (c) => c.assertions.push(clone(c.assertions[0]))],
  ['unsupported event kind', (c) => (c.events[0].kind = 'exec')],
  ['missing boundary data', (c) => delete c.events[0].data],
  ['invalid outcome', (c) => (c.events[0].outcome = 'maybe')],
  ['negative timestamp', (c) => (c.events[0].atMs = -1)],
  ['infinite timestamp', (c) => (c.events[0].atMs = Infinity)],
  ['unsafe timestamp integer', (c) => (c.events[0].atMs = Number.MAX_SAFE_INTEGER + 1)],
  ['empty title', (c) => (c.title = '')],
  ['oversize title', (c) => (c.title = 'x'.repeat(257))],
  ['bad identifier', (c) => (c.id = '../../outside')],
  ['empty events', (c) => (c.events = [])],
  ['missing assertions', (c) => delete c.assertions],
  ['missing capture gaps', (c) => delete c.capture.missing],
  ['invalid createdAt', (c) => (c.createdAt = 'yesterday')],
  ['non-UTC createdAt', (c) => (c.createdAt = '2026-01-15T12:00:00+01:00')],
  ['impossible calendar date', (c) => (c.createdAt = '2026-02-30T00:00:00Z')],
  ['malformed assertion pointer', (c) => (c.assertions = [valueAssertion('/data/~2', 1)])],
  ['relative assertion pointer', (c) => (c.assertions = [valueAssertion('data/x', 1)])],
  ['prototype assertion pointer', (c) => (c.assertions = [valueAssertion('/data/__proto__/x', 1)])],
  [
    'unknown event reference',
    (c) => (c.assertions = [{ ...valueAssertion('/data/x', 1), eventId: 'missing' }]),
  ],
  [
    'missing expected value',
    (c) => {
      c.assertions = [valueAssertion('/data/x', 1)];
      delete c.assertions[0].expected;
    },
  ],
  [
    'fractional event count',
    (c) =>
      (c.assertions = [{ id: 'count', kind: 'event.count', eventKind: 'run.end', equals: 0.5 }]),
  ],
  [
    'negative event count',
    (c) =>
      (c.assertions = [{ id: 'count', kind: 'event.count', eventKind: 'run.end', equals: -1 }]),
  ],
  ['invalid redaction pointer', (c) => (c.redactions = [{ pointer: '', reason: 'test' }])],
  ['oversize string', (c) => (c.events[0].data = 'x'.repeat(131073))],
  [
    'too deeply nested JSON',
    (c) => {
      let v = {};
      for (let i = 0; i < 35; i++) v = { nested: v };
      c.events[0].data = v;
    },
  ],
];
for (const [name, mutate] of malformed) {
  test(`rejects ${name}`, () => {
    const c = minimal();
    mutate(c);
    assert.equal(validateCasefile(c).valid, false);
  });
}

test('parsing errors omit the invalid input contents', () => {
  const result = parseCasefile('{"do-not-print-this-secret":');
  assert.equal(result.valid, false);
  assert.equal(result.diagnostics[0].code, 'input.json');
  assert.ok(!JSON.stringify(result).includes('do-not-print-this-secret'));
});
test('parse limits are UTF-8 byte based', () => {
  const result = parseCasefile('é'.repeat(Math.floor(MAX_BYTES / 2) + 1));
  assert.equal(result.valid, false);
  assert.equal(result.diagnostics[0].code, 'input.size');
});
test('prototype-related keys in parsed payloads are rejected without pollution', () => {
  const c = minimal();
  c.events[0].data = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.equal(validateCasefile(c).valid, false);
  assert.equal({}.polluted, undefined);
});
for (const [name, value] of [
  ['undefined', undefined],
  ['bigint', 1n],
  ['NaN', NaN],
  ['function', () => 42],
  ['Date', new Date(0)],
]) {
  test(`rejects non-JSON ${name} data`, () => {
    const c = minimal();
    c.events[0].data = value;
    assert.equal(validateCasefile(c).valid, false);
  });
}
test('cyclic data is rejected without recursing indefinitely', () => {
  const c = minimal();
  const v = {};
  v.self = v;
  c.events[0].data = v;
  assert.equal(validateCasefile(c).valid, false);
});
test('shared object identities must be serialized to plain JSON before validation', () => {
  const same = { x: 1 },
    c = minimal({ a: same, b: same });
  assert.equal(validateCasefile(c).valid, false);
  assert.equal(parseCasefile(JSON.stringify(c)).valid, true);
});
test('enumerable accessors are not invoked', () => {
  let reads = 0;
  const c = minimal();
  Object.defineProperty(c.events[0].data, 'value', {
    enumerable: true,
    get() {
      reads++;
      return 'x';
    },
  });
  assert.equal(validateCasefile(c).valid, false);
  assert.equal(reads, 0);
});
test('non-enumerable accessors are rejected without invocation', () => {
  let reads = 0;
  const c = minimal();
  Object.defineProperty(c.events[0].data, 'value', {
    get() {
      reads++;
      return 'x';
    },
  });
  assert.equal(validateCasefile(c).valid, false);
  assert.equal(reads, 0);
});
test('non-enumerable toJSON functions are rejected without invocation', () => {
  let calls = 0;
  const c = minimal();
  Object.defineProperty(c.events[0].data, 'toJSON', {
    value() {
      calls++;
      return 'changed';
    },
  });
  assert.equal(validateCasefile(c).valid, false);
  assert.equal(calls, 0);
});
test('sparse arrays are not accepted as recorded JSON', () => {
  const c = minimal(new Array(3));
  assert.equal(validateCasefile(c).valid, false);
});
test('arrays with extra enumerable properties are rejected', () => {
  const data = [];
  data.extra = 'not serialized';
  assert.equal(validateCasefile(minimal(data)).valid, false);
});
test('event order must be nondecreasing, even with valid boundaries', () => {
  const c = fixture('tool-timeout');
  c.events[1].atMs = -0.5;
  assert.equal(validateCasefile(c).valid, false);
  c.events[1].atMs = 100;
  c.events[2].atMs = 50;
  assert.equal(validateCasefile(c).valid, false);
});
test('timestamp ties preserve event array order', () => {
  const c = fixture('tool-timeout-fixed');
  c.events.forEach((e) => (e.atMs = 0));
  assert.equal(validateCasefile(c).valid, true);
  assert.equal(replayCasefile(c).status, 'pass');
});
test('missing terminal evidence cannot produce overall pass', () => {
  const c = fixture('tool-timeout-fixed');
  c.events.pop();
  c.assertions = [{ id: 'settled', kind: 'calls.settled', boundary: 'all' }];
  const valid = validateCasefile(c);
  assert.equal(valid.valid, true);
  assert.ok(valid.diagnostics.some((d) => d.code === 'capture.terminal'));
  assert.equal(replayCasefile(c).status, 'inconclusive');
});
test('orphan and duplicate boundary results are diagnosed and fail settlement', () => {
  const c = fixture('tool-timeout-fixed');
  c.events[3].callId = 'not-called';
  const result = validateCasefile(c);
  assert.ok(result.diagnostics.some((d) => d.code === 'boundary.orphan'));
  assert.ok(result.diagnostics.some((d) => d.code === 'boundary.unsettled'));
  assert.equal(replayCasefile(c).assertions[0].status, 'fail');
});
test('reused call IDs cannot silently pass settlement', () => {
  const c = fixture('tool-timeout-fixed');
  c.events[4].callId = 'model-1';
  c.events[5].callId = 'model-1';
  assert.ok(validateCasefile(c).diagnostics.some((d) => d.code === 'boundary.duplicate'));
  assert.equal(replayCasefile(c).assertions[0].status, 'fail');
});
test('tool-only settlement does not inherit an unrelated unsettled model assertion', () => {
  const c = fixture('tool-timeout-fixed');
  c.events.splice(5, 1);
  c.assertions = [
    { id: 'tools', kind: 'calls.settled', boundary: 'tool' },
    { id: 'models', kind: 'calls.settled', boundary: 'model' },
  ];
  const result = replayCasefile(c);
  assert.equal(result.assertions[0].status, 'pass');
  assert.equal(result.assertions[1].status, 'fail');
});
test('partial exact counts are inconclusive unless observed count already exceeds expectation', () => {
  const c = minimal();
  c.capture = { status: 'partial', missing: ['Stream truncated'] };
  c.assertions = [
    { id: 'one', kind: 'event.count', eventKind: 'run.end', equals: 1 },
    { id: 'zero', kind: 'event.count', eventKind: 'run.end', equals: 0 },
  ];
  const report = replayCasefile(c);
  assert.equal(report.assertions[0].status, 'inconclusive');
  assert.equal(report.assertions[1].status, 'fail');
});
test('empty assertion set is never presented as a successful regression', () => {
  const c = minimal();
  c.assertions = [];
  assert.equal(replayCasefile(c).status, 'inconclusive');
});
test('assertions distinguish missing values from null and use object key-order-independent equality', () => {
  const c = minimal({ x: null, obj: { a: 1, b: [2, null] } });
  c.assertions = [
    valueAssertion('/data/obj', { b: [2, null], a: 1 }),
    { ...valueAssertion('/data/x', null), id: 'null' },
    absentAssertion('/data/missing'),
  ];
  assert.equal(replayCasefile(c).status, 'pass');
  c.assertions = [valueAssertion('/data/missing', null)];
  assert.equal(replayCasefile(c).status, 'fail');
});
test('JSON pointers correctly escape keys and reject ambiguous array indexes', () => {
  const value = { 'a/b': { '~key': [7] } };
  assert.deepEqual(getPointer(value, '/a~1b/~0key/0'), { found: true, value: 7 });
  assert.equal(getPointer(value, '/a~1b/~0key/00').found, false);
  assert.equal(getPointer(value, '/a~1b/~0key/-').found, false);
  assert.equal(pointerParts('/bad~2'), null);
  assert.equal(getPointer({}, '/toString').found, false);
});
test('replay reports omit sensitive observed and expected payloads', () => {
  const c = minimal({ x: 'sensitive-observed-text' });
  c.assertions = [valueAssertion('/data/x', 'sensitive-expected-text')];
  const output = JSON.stringify(replayCasefile(c));
  assert.ok(!output.includes('sensitive-observed-text'));
  assert.ok(!output.includes('sensitive-expected-text'));
});
test('invalid input cannot be replayed', () => {
  const c = minimal();
  c.version = '99';
  assert.throws(() => replayCasefile(c), /invalid casefile/);
});

test('privacy preview reports locations and reasons but not raw values', () => {
  const c = minimal({ api_key: 'demo-only-credential', email: 'engineer@example.test' });
  const findings = privacyFindings(c);
  assert.equal(findings.length, 2);
  assert.ok(findings.some((f) => f.pointer === '/events/0/data/api_key'));
  assert.ok(!JSON.stringify(findings).includes('demo-only-credential'));
  assert.ok(!JSON.stringify(findings).includes('engineer@example.test'));
});
for (const [label, value] of [
  ['bearer', 'Bearer demonstration-not-a-real-token'],
  ['API token', 'sk-original-fake-token-for-tests'],
  ['GitHub token', 'ghp_originalFakeToken0123456789'],
  ['private key', '-----BEGIN PRIVATE KEY----- demonstration only'],
  ['URL credentials', 'https://demo:fake@example.test/path'],
  ['URL parameter', 'https://example.test/path?token=demo-only'],
  ['assignment', 'password=demo-only'],
]) {
  test(`privacy scanner redacts ${label} in arbitrary string fields`, () => {
    const c = minimal({ message: value });
    const redacted = redactCasefile(c);
    assert.equal(redacted.casefile.events[0].data.message, REDACTED);
    assert.ok(!JSON.stringify(redacted.casefile).includes(value));
  });
}
test('redaction clones the input, records a ledger and is idempotent', () => {
  const c = minimal({ password: 'demo-only', safe: 'visible' }),
    original = clone(c);
  const first = redactCasefile(c);
  assert.deepEqual(c, original);
  assert.equal(first.changed, true);
  assert.equal(first.casefile.events[0].data.password, REDACTED);
  assert.equal(first.casefile.events[0].data.safe, 'visible');
  assert.equal(first.casefile.redactions.length, 1);
  const second = redactCasefile(first.casefile);
  assert.equal(second.changed, false);
  assert.deepEqual(second.casefile, first.casefile);
});
test('explicit redaction supports escaped paths and deduplicates overlapping replacements', () => {
  const c = minimal({ 'a/b': { password: 'demo-only', other: 42 } });
  const result = redactCasefile(c, { pointers: ['/events/0/data/a~1b', '/events/0/data/a~1b'] });
  assert.equal(result.casefile.events[0].data['a/b'], REDACTED);
  assert.equal(result.findings.length, 1);
});
for (const pointer of ['', '/missing', '/events/0/data/~3', '/redactions', '/format']) {
  test(`unsafe or invalid redaction target ${JSON.stringify(pointer)} is refused`, () => {
    assert.throws(() => redactCasefile(minimal(), { pointers: [pointer] }));
  });
}
test('secret-bearing property names block sharing instead of leaking in preview paths', () => {
  const c = minimal({ 'engineer@example.test': 'value' });
  assert.throws(
    () => privacyFindings(c),
    (error) => !error.message.includes('engineer@example.test'),
  );
  assert.throws(() => redactCasefile(c));
});
test('existing ledger metadata cannot smuggle sensitive values through redaction', () => {
  const c = minimal({ old: REDACTED });
  c.redactions = [
    { pointer: '/events/0/data/old', reason: 'Contact engineer@example.test for the password' },
  ];
  let result;
  try {
    result = redactCasefile(c);
  } catch (error) {
    // Refusing the export is safe too; a failure must not echo the secret.
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes('engineer@example.test'));
    return;
  }
  assert.ok(!JSON.stringify(result.casefile).includes('engineer@example.test'));
});
test('redacted values cannot become a false equality pass', () => {
  const c = minimal({ apiKey: 'demo-one' });
  c.assertions = [valueAssertion('/data/apiKey', 'demo-two')];
  const safe = redactCasefile(c).casefile;
  assert.equal(replayCasefile(safe).status, 'inconclusive');
});
test('redacted expected values make equality inconclusive even when observed data is present', () => {
  const c = minimal({ x: 'anything' });
  c.assertions = [valueAssertion('/data/x', 'engineer@example.test')];
  assert.equal(replayCasefile(redactCasefile(c).casefile).status, 'inconclusive');
});
test('absence beneath a redacted parent cannot silently pass', () => {
  const c = minimal({ credentials: { name: 'hidden' } });
  c.assertions = [absentAssertion('/data/credentials/not-there')];
  assert.equal(replayCasefile(redactCasefile(c).casefile).status, 'inconclusive');
});
test('literal redaction marker ancestors are inconclusive even without a ledger', () => {
  const c = minimal({ hidden: REDACTED });
  c.assertions = [absentAssertion('/data/hidden/not-there')];
  assert.equal(replayCasefile(c).status, 'inconclusive');
});
test('unrelated redacted fields do not prevent checking unaffected evidence', () => {
  const c = minimal({ password: 'demo-only', state: 'done' });
  c.assertions = [valueAssertion('/data/state', 'done')];
  assert.equal(replayCasefile(redactCasefile(c).casefile).status, 'pass');
});
test('comparison labels changed assertion definitions rather than implying a code fix', () => {
  const before = fixture('tool-timeout'),
    after = fixture('tool-timeout-fixed');
  let comparison = compareCasefiles(before, after);
  assert.equal(comparison.mode, 'recording-comparison');
  assert.equal(comparison.before.status, 'fail');
  assert.equal(comparison.after.status, 'pass');
  assert.ok(comparison.assertionChanges.every((a) => !a.definitionChanged));
  after.assertions.at(-1).expected = 'running';
  comparison = compareCasefiles(before, after);
  assert.equal(comparison.assertionChanges.at(-1).definitionChanged, true);
  assert.match(comparison.note, /does not execute an agent/);
});
test('comparison explicitly identifies removed and added assertions', () => {
  const before = minimal(),
    after = minimal();
  after.assertions = [{ id: 'terminal', kind: 'event.exists', eventKind: 'run.end' }];
  const report = compareCasefiles(before, after);
  assert.deepEqual(
    report.assertionChanges.map((a) => [a.id, a.before, a.after, a.definitionChanged]),
    [
      ['outcome', 'pass', 'not-present', true],
      ['terminal', 'not-present', 'pass', true],
    ],
  );
});

test('event, assertion and metadata collection sizes are bounded', () => {
  for (const mutate of [
    (c) => (c.events = Array.from({ length: 10001 }, (_, i) => ({ ...c.events[0], id: `e-${i}` }))),
    (c) =>
      (c.assertions = Array.from({ length: 1001 }, (_, i) => ({
        ...c.assertions[0],
        id: `a-${i}`,
      }))),
    (c) => (c.capture.missing = Array.from({ length: 101 }, () => 'gap')),
    (c) =>
      (c.redactions = Array.from({ length: 10001 }, () => ({
        pointer: '/events/0/data',
        reason: 'test',
      }))),
  ]) {
    const c = minimal();
    mutate(c);
    assert.equal(validateCasefile(c).valid, false);
  }
});
test('total JSON node count is bounded independently of depth', () => {
  assert.equal(validateCasefile(minimal(Array(100001).fill(1))).valid, false);
});
test('complete capture claims with declared gaps remain inconclusive', () => {
  const c = minimal();
  c.capture.missing = ['A tool was not instrumented'];
  assert.equal(replayCasefile(c).status, 'inconclusive');
});
test('multiple terminal events cannot establish an outcome', () => {
  const c = minimal();
  c.events.push({ ...clone(c.events[0]), id: 'other-end' });
  assert.equal(replayCasefile(c).assertions[0].status, 'inconclusive');
});
test('a terminal event before later boundary events is an incomplete capture', () => {
  const c = minimal();
  c.events.push({
    id: 'request-after-end',
    kind: 'model.request',
    atMs: 1,
    callId: 'late',
    data: {},
  });
  assert.ok(validateCasefile(c).diagnostics.some((d) => d.code === 'capture.terminal'));
  assert.equal(replayCasefile(c).status, 'inconclusive');
});
test('strings resembling scripts remain inert data during offline evaluation', () => {
  const source = 'globalThis.__casefileTestExecuted = true';
  const c = minimal({ source });
  c.assertions = [valueAssertion('/data/source', source)];
  assert.equal(replayCasefile(c).status, 'pass');
  redactCasefile(c);
  assert.equal(globalThis.__casefileTestExecuted, undefined);
});
test('schema exposes the versioned closed event and assertion vocabularies', () => {
  const schema = JSON.parse(
    readFileSync(new URL('../schema/casefile.schema.json', import.meta.url), 'utf8'),
  );
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.version.const, '1.0');
  assert.equal(schema.$defs.event.oneOf.length, 5);
  assert.equal(schema.$defs.assertion.oneOf.length, 6);
  assert.ok(schema.$defs.event.oneOf.every((branch) => branch.additionalProperties === false));
  assert.ok(schema.$defs.assertion.oneOf.every((branch) => branch.additionalProperties === false));
});

test(
  'privacy scanning bounds large numbers of findings before redaction work',
  { timeout: 3000 },
  () => {
    const c = minimal(Array.from({ length: 30000 }, () => ({ apiKey: 'demo-only' })));
    assert.equal(validateCasefile(c).valid, true);
    const start = performance.now();
    assert.throws(() => privacyFindings(c), /5000 findings/);
    assert.throws(() => redactCasefile(c), /5000 findings/);
    assert.ok(performance.now() - start < 2500, 'Privacy finding limit should fail promptly.');
  },
);
test(
  'privacy patterns handle long colon chains and failed dotted email matches without pathological backtracking',
  { timeout: 3000 },
  () => {
    const c = minimal({
      colonChain: 'https://' + 'x:'.repeat(60000),
      failedEmail: 'a@' + 'a.'.repeat(60000) + '1',
    });
    const start = performance.now();
    const findings = privacyFindings(c);
    assert.deepEqual(findings, []);
    assert.ok(performance.now() - start < 2500, 'Adversarial strings should scan in bounded time.');
  },
);
test('URL credentials with colon-bearing passwords are still redacted', () => {
  const c = minimal({ url: 'https://demo:multiple:colon:password@host.invalid/path' });
  assert.equal(redactCasefile(c).casefile.events[0].data.url, REDACTED);
});
test('direct object validation applies the total UTF-8 byte limit too', () => {
  const c = minimal(Array.from({ length: 60 }, () => 'é'.repeat(50000)));
  assert.equal(validateCasefile(c).valid, false);
});

test('serialized control-character expansion cannot exceed the byte limit', async () => {
  const c = fixture('tool-timeout');
  c.events[0].data = Array.from({ length: 7 }, () => '\u0000'.repeat(130000));
  assert.equal(validateCasefile(c).valid, false);
});

test('serializer falls back to compact JSON when indentation would exceed intake limits', () => {
  const c = minimal(
    Array.from({ length: 3000 }, () => {
      let v = 0;
      for (let i = 0; i < 26; i++) v = { x: v };
      return v;
    }),
  );
  assert.equal(validateCasefile(c).valid, true);
  assert.ok(new TextEncoder().encode(JSON.stringify(c, null, 2)).length > MAX_BYTES);
  const serialized = serializeCasefile(c);
  assert.ok(new TextEncoder().encode(serialized).length <= MAX_BYTES);
  assert.equal(parseCasefile(serialized).valid, true);
  assert.deepEqual(JSON.parse(serialized), c);
});

test('exact serialized byte cap includes empty container punctuation and final newline policy', () => {
  const sized = (size) => {
    const c = minimal(Array(40).fill(''));
    c.assertions = [];
    const fill = size - new TextEncoder().encode(JSON.stringify(c)).length;
    c.events[0].data = Array.from({ length: 40 }, (_, i) =>
      'x'.repeat(Math.floor(fill / 40) + (i < fill % 40 ? 1 : 0)),
    );
    assert.equal(new TextEncoder().encode(JSON.stringify(c)).length, size);
    return c;
  };
  const exact = sized(MAX_BYTES);
  assert.equal(validateCasefile(exact).valid, true);
  const output = serializeCasefile(exact);
  assert.equal(new TextEncoder().encode(output).length, MAX_BYTES);
  assert.equal(output.endsWith('\n'), false);
  assert.equal(parseCasefile(output).valid, true);
  assert.equal(validateCasefile(sized(MAX_BYTES + 1)).valid, false);
});
