import { EVENT_KINDS } from './types.js';
import type { Casefile, Diagnostic, Json, ValidationResult } from './types.js';
export const MAX_BYTES = 5 * 1024 * 1024;
const MAX_NODES = 100_000;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
export function pointerEscape(s: string): string {
  return s.replace(/~/g, '~0').replace(/\//g, '~1');
}
export function pointerParts(pointer: string): string[] | null {
  if (pointer === '') return [];
  if (!pointer.startsWith('/') || /~(?:[^01]|$)/.test(pointer)) return null;
  const parts = pointer
    .slice(1)
    .split('/')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  return parts.some((p) => forbidden.has(p)) ? null : parts;
}
export function getPointer(value: unknown, pointer: string): { found: boolean; value?: unknown } {
  const parts = pointerParts(pointer);
  if (!parts) return { found: false };
  let current = value;
  for (const part of parts) {
    if (Array.isArray(current) && !/^(0|[1-9]\d*)$/.test(part)) return { found: false };
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, part))
      return { found: false };
    current = (current as Record<string, unknown>)[part];
  }
  return { found: true, value: current };
}
/** Bounds work and rejects non-JSON values before structural validation. */
function jsonCheck(value: unknown): string | null {
  let nodes = 0;
  let bytes = 0;
  const seen = new WeakSet<object>();
  const walk = (v: unknown, depth: number): string | null => {
    if (++nodes > MAX_NODES || depth > 32) return 'Data exceeds the node or nesting limit.';
    if (typeof v === 'string') {
      bytes += new TextEncoder().encode(JSON.stringify(v)).length;
      return bytes > MAX_BYTES || v.length > 131072
        ? 'Data exceeds the string or total size limit.'
        : null;
    }
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) {
      bytes += JSON.stringify(v).length;
      return bytes > MAX_BYTES ? 'Data exceeds the total size limit.' : null;
    }
    if (typeof v !== 'object') return 'Only finite, plain JSON values are accepted.';
    if (seen.has(v))
      return 'Circular or shared object references are not accepted; supply JSON data.';
    seen.add(v);
    if (
      !Array.isArray(v) &&
      Object.getPrototypeOf(v) !== Object.prototype &&
      Object.getPrototypeOf(v) !== null
    )
      return 'Only plain JSON objects are accepted.';
    if (Object.getOwnPropertySymbols(v).length) return 'Symbol keys are not accepted.';
    const keys = Object.getOwnPropertyNames(v).filter(
      (key) => !(Array.isArray(v) && key === 'length'),
    );
    if (
      Array.isArray(v) &&
      (keys.length !== v.length || keys.some((key) => !/^(0|[1-9]\d*)$/.test(key)))
    )
      return 'Sparse arrays and named array properties are not accepted.';
    bytes += 2 + Math.max(0, keys.length - 1);
    if (bytes > MAX_BYTES) return 'Data exceeds the total size limit.';
    for (const key of keys) {
      if (forbidden.has(key)) return 'Prototype-related property names are not accepted.';
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
        return 'Accessors and non-enumerable properties are not accepted.';
      if (!Array.isArray(v)) bytes += new TextEncoder().encode(JSON.stringify(key)).length + 1;
      if (bytes > MAX_BYTES) return 'Data exceeds the total size limit.';
      const issue = walk(descriptor.value, depth + 1);
      if (issue) return issue;
    }
    return null;
  };
  return walk(value, 0);
}
export function parseCasefile(text: string): ValidationResult {
  if (new TextEncoder().encode(text).length > MAX_BYTES)
    return invalid('input.size', '', 'Casefiles are limited to 5 MiB.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalid(
      'input.json',
      '',
      'Invalid JSON. No input content has been included in this error.',
    );
  }
  return validateCasefile(parsed);
}
function invalid(code: string, path: string, message: string): ValidationResult {
  return { valid: false, diagnostics: [{ severity: 'error', code, path, message }] };
}
export function validateCasefile(input: unknown): ValidationResult {
  const unsafe = jsonCheck(input);
  if (unsafe) return invalid('input.unsafe', '', unsafe);
  const diagnostics: Diagnostic[] = [];
  const error = (path: string, message: string) => {
    if (diagnostics.length < 100)
      diagnostics.push({ severity: 'error', code: 'schema.invalid', path, message });
  };
  const fields = (v: Record<string, unknown>, allowed: string[], path: string) => {
    if (Object.keys(v).some((k) => !allowed.includes(k)))
      error(path, 'Unknown fields are not accepted in version 1.0.');
  };
  const str = (v: unknown, path: string, max = 4096): v is string => {
    const ok = typeof v === 'string' && v.length > 0 && v.length <= max;
    if (!ok) error(path, `Expected a non-empty string of at most ${max} characters.`);
    return ok;
  };
  const id = (v: unknown, path: string) => {
    if (typeof v !== 'string' || !idPattern.test(v))
      error(
        path,
        'Expected an ID with 1–128 letters, digits, dots, colons, underscores or hyphens.',
      );
  };
  const oneOf = (v: unknown, options: readonly unknown[], path: string) => {
    if (!options.includes(v)) error(path, 'Value is not in the supported set.');
  };
  const obj = (v: unknown, path: string): v is Record<string, unknown> => {
    if (!object(v)) {
      error(path, 'Expected an object.');
      return false;
    }
    return true;
  };
  if (!obj(input, '')) return { valid: false, diagnostics };
  fields(
    input,
    [
      'format',
      'version',
      'id',
      'title',
      'description',
      'createdAt',
      'provenance',
      'environment',
      'capture',
      'events',
      'assertions',
      'redactions',
    ],
    '',
  );
  oneOf(input.format, ['agent-casefile'], '/format');
  oneOf(input.version, ['1.0'], '/version');
  id(input.id, '/id');
  str(input.title, '/title', 256);
  if (input.description !== undefined) str(input.description, '/description');
  if (
    typeof input.createdAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(input.createdAt) ||
    !Number.isFinite(Date.parse(input.createdAt)) ||
    new Date(input.createdAt).toISOString() !==
      input.createdAt.replace(
        /(?:\.(\d{1,3}))?Z$/,
        (_, ms: string | undefined) => '.' + (ms ?? '').padEnd(3, '0') + 'Z',
      )
  )
    error('/createdAt', 'Expected a real ISO 8601 UTC timestamp.');
  if (obj(input.provenance, '/provenance')) {
    fields(input.provenance, ['kind', 'source', 'notes'], '/provenance');
    oneOf(input.provenance.kind, ['synthetic', 'recorded'], '/provenance/kind');
    for (const k of ['source', 'notes'])
      if (input.provenance[k] !== undefined) str(input.provenance[k], '/provenance/' + k);
  }
  if (obj(input.environment, '/environment')) {
    fields(input.environment, ['runtime', 'framework', 'model'], '/environment');
    str(input.environment.runtime, '/environment/runtime', 256);
    for (const [key, names] of [
      ['framework', ['name', 'version']],
      ['model', ['provider', 'name']],
    ] as const) {
      const value = input.environment[key];
      if (value === undefined) continue;
      if (obj(value, '/environment/' + key)) {
        fields(value, [...names], '/environment/' + key);
        for (const n of names) str(value[n], '/environment/' + key + '/' + n, 256);
      }
    }
  }
  if (obj(input.capture, '/capture')) {
    fields(input.capture, ['status', 'missing'], '/capture');
    oneOf(input.capture.status, ['complete', 'partial'], '/capture/status');
    if (!Array.isArray(input.capture.missing) || input.capture.missing.length > 100)
      error('/capture/missing', 'Expected an array with at most 100 capture gaps.');
    else input.capture.missing.forEach((m, i) => str(m, '/capture/missing/' + i));
  }
  const eventIds = new Set<string>();
  let previousTime = -1;
  if (!Array.isArray(input.events) || input.events.length < 1 || input.events.length > 10000)
    error('/events', 'Expected 1–10000 recorded events.');
  else
    input.events.forEach((event: unknown, i) => {
      const p = '/events/' + i;
      if (!obj(event, p)) return;
      const extra =
        event.kind === 'run.end'
          ? ['outcome']
          : event.kind === 'tool.call'
            ? ['callId', 'name']
            : event.kind === 'tool.result'
              ? ['callId', 'outcome']
              : ['callId'];
      fields(event, ['id', 'kind', 'atMs', 'data', ...extra], p);
      id(event.id, p + '/id');
      if (typeof event.id === 'string') {
        if (eventIds.has(event.id)) error(p + '/id', 'Event IDs must be unique.');
        eventIds.add(event.id);
      }
      oneOf(event.kind, EVENT_KINDS, p + '/kind');
      if (
        typeof event.atMs !== 'number' ||
        !Number.isFinite(event.atMs) ||
        event.atMs < 0 ||
        event.atMs > Number.MAX_SAFE_INTEGER
      )
        error(p + '/atMs', 'Expected finite nonnegative elapsed milliseconds.');
      else {
        if (event.atMs < previousTime)
          error(p + '/atMs', 'Events must be ordered by atMs; ties preserve array order.');
        previousTime = event.atMs;
      }
      if (!Object.hasOwn(event, 'data'))
        error(
          p + '/data',
          'Boundary data is required; use null when explicitly recorded as empty.',
        );
      if (event.kind !== 'run.end') id(event.callId, p + '/callId');
      if (event.kind === 'tool.call') str(event.name, p + '/name', 128);
      if (event.kind === 'tool.result')
        oneOf(event.outcome, ['success', 'error', 'timeout'], p + '/outcome');
      if (event.kind === 'run.end')
        oneOf(event.outcome, ['success', 'error', 'cancelled'], p + '/outcome');
    });
  const assertionIds = new Set<string>();
  if (!Array.isArray(input.assertions) || input.assertions.length > 1000)
    error('/assertions', 'Expected an array of at most 1000 assertions.');
  else
    input.assertions.forEach((a: unknown, i) => {
      const p = '/assertions/' + i;
      if (!obj(a, p)) return;
      const kindFields: Record<string, string[]> = {
        'event.exists': ['eventKind'],
        'event.count': ['eventKind', 'equals'],
        'value.equals': ['eventId', 'pointer', 'expected'],
        'value.absent': ['eventId', 'pointer'],
        'calls.settled': ['boundary'],
        'run.outcome': ['equals'],
      };
      const kind = typeof a.kind === 'string' ? a.kind : '';
      const extras = Object.hasOwn(kindFields, kind) ? kindFields[kind]! : [];
      fields(a, ['id', 'kind', 'description', ...extras], p);
      oneOf(kind, Object.keys(kindFields), p + '/kind');
      id(a.id, p + '/id');
      if (typeof a.id === 'string') {
        if (assertionIds.has(a.id)) error(p + '/id', 'Assertion IDs must be unique.');
        assertionIds.add(a.id);
      }
      if (a.description !== undefined) str(a.description, p + '/description');
      if (kind === 'event.exists' || kind === 'event.count')
        oneOf(a.eventKind, EVENT_KINDS, p + '/eventKind');
      if (
        kind === 'event.count' &&
        (typeof a.equals !== 'number' ||
          !Number.isSafeInteger(a.equals) ||
          a.equals < 0 ||
          a.equals > 10000)
      )
        error(p + '/equals', 'Expected an integer count from 0 to 10000.');
      if (kind === 'value.equals' || kind === 'value.absent') {
        id(a.eventId, p + '/eventId');
        if (typeof a.eventId === 'string' && !eventIds.has(a.eventId))
          error(p + '/eventId', 'Assertion targets an event that is not present.');
        if (
          typeof a.pointer !== 'string' ||
          a.pointer.length > 1024 ||
          pointerParts(a.pointer) === null
        )
          error(p + '/pointer', 'Expected a valid RFC 6901 JSON pointer relative to the event.');
        if (kind === 'value.equals' && !Object.hasOwn(a, 'expected'))
          error(p + '/expected', 'Expected value is required.');
      }
      if (kind === 'calls.settled') oneOf(a.boundary, ['tool', 'model', 'all'], p + '/boundary');
      if (kind === 'run.outcome') oneOf(a.equals, ['success', 'error', 'cancelled'], p + '/equals');
    });
  if (input.redactions !== undefined) {
    if (!Array.isArray(input.redactions) || input.redactions.length > 10000)
      error('/redactions', 'Expected up to 10000 redaction records.');
    else
      input.redactions.forEach((r: unknown, i) => {
        const p = '/redactions/' + i;
        if (!obj(r, p)) return;
        fields(r, ['pointer', 'reason'], p);
        if (
          typeof r.pointer !== 'string' ||
          pointerParts(r.pointer) === null ||
          !r.pointer.startsWith('/')
        )
          error(p + '/pointer', 'Expected an absolute non-root JSON pointer.');
        str(r.reason, p + '/reason', 256);
      });
  }
  if (diagnostics.length) return { valid: false, diagnostics };
  const casefile = input as unknown as Casefile;
  diagnostics.push(...completeness(casefile));
  return { valid: true, diagnostics, casefile };
}
export function completeness(c: Casefile): Diagnostic[] {
  const ds: Diagnostic[] = [];
  const warn = (code: string, path: string, message: string) =>
    ds.push({ severity: 'warning', code, path, message } as Diagnostic);
  if (c.capture.status === 'partial' || c.capture.missing.length)
    warn(
      'capture.partial',
      '/capture',
      'The capture declares missing evidence. Passing checks do not prove the run was complete.',
    );
  if (!c.assertions.length)
    warn('assertions.empty', '/assertions', 'No regression assertions are defined.');
  const ends = c.events.filter((e) => e.kind === 'run.end');
  if (ends.length !== 1 || c.events.at(-1)?.kind !== 'run.end')
    warn('capture.terminal', '/events', 'Expected exactly one run.end as the final event.');
  for (const boundary of ['model', 'tool'] as const) {
    const open = new Set<string>();
    const seen = new Set<string>();
    c.events.forEach((e, i) => {
      if (e.kind === (boundary === 'tool' ? 'tool.call' : 'model.request') && 'callId' in e) {
        if (seen.has(e.callId))
          warn('boundary.duplicate', '/events/' + i, 'A boundary call ID was reused.');
        seen.add(e.callId);
        open.add(e.callId);
      }
      if (e.kind === (boundary === 'tool' ? 'tool.result' : 'model.response') && 'callId' in e) {
        if (!open.delete(e.callId))
          warn(
            'boundary.orphan',
            '/events/' + i,
            'A result has no preceding unmatched request or call.',
          );
      }
    });
    if (open.size)
      warn(
        'boundary.unsettled',
        '/events',
        `${open.size} ${boundary} boundary call(s) lack a recorded result.`,
      );
  }
  return ds;
}
export function isJson(value: unknown): value is Json {
  return jsonCheck(value) === null;
}

/** Human-readable when possible; always round-trips within the serialized intake limit. */
export function serializeCasefile(c: Casefile): string {
  if (!validateCasefile(c).valid) throw new Error('Cannot serialize an invalid casefile.');
  const pretty = JSON.stringify(c, null, 2) + '\n';
  if (new TextEncoder().encode(pretty).length <= MAX_BYTES) return pretty;
  const compact = JSON.stringify(c);
  return new TextEncoder().encode(compact).length < MAX_BYTES ? compact + '\n' : compact;
}
