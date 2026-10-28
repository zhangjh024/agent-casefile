import type { Casefile, Json, RedactionRecord } from './types.js';
import { getPointer, pointerEscape, pointerParts, validateCasefile } from './validation.js';
export const REDACTED = '[REDACTED]';
export const MAX_FINDINGS = 5000;
function addFinding(findings: RedactionRecord[], finding: RedactionRecord): void {
  if (findings.length >= MAX_FINDINGS)
    throw new Error(
      'Privacy scan exceeds 5000 findings. Split or minimize this recording before redaction or export.',
    );
  findings.push(finding);
}
const sensitiveKey =
  /^(?:authorization|proxyauthorization|cookie|setcookie|password|passwd|pwd|secret|clientsecret|apikey|accesstoken|refreshtoken|idtoken|token|privatekey|credentials|sessionid)$/i;
const stringRules: [string, RegExp][] = [
  ['email address', /[A-Z0-9._%+-]@[A-Z0-9.-]*\.[A-Z]{2}/i],
  ['bearer credential', /\bBearer\s+[^\s"']+/i],
  [
    'API credential pattern',
    /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16})\b/,
  ],
  ['private key material', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],
  [
    'credential assignment',
    /\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*[^\s&;,]+/i,
  ],
  ['URL credential', /https?:\/\/[^:\s/]+:[^\s/@]+@/i],
  [
    'sensitive URL parameter',
    /[?&](?:token|api[_-]?key|secret|password|auth|signature|sig)=[^&#\s]+/i,
  ],
];
function reasonForString(s: string): string | undefined {
  return stringRules.find(([, pattern]) => pattern.test(s))?.[0];
}
function scan(value: unknown, path = '', findings: RedactionRecord[] = []): RedactionRecord[] {
  if (value === REDACTED) return findings;
  if (typeof value === 'string') {
    const reason = reasonForString(value);
    if (reason) addFinding(findings, { pointer: path, reason });
    return findings;
  }
  if (value === null || typeof value !== 'object') return findings;
  for (const [key, child] of Object.entries(value)) {
    const pointer = path + '/' + pointerEscape(key);
    // Property names are retained by redaction. Do not silently share a secret encoded as a key.
    if (reasonForString(key))
      throw new Error(
        'A property name may contain sensitive data. Rename that property locally before exporting.',
      );
    if (child !== REDACTED && sensitiveKey.test(key.replace(/[-_\s]/g, '')))
      addFinding(findings, { pointer, reason: 'sensitive field name' });
    else scan(child, pointer, findings);
  }
  return findings;
}
export function privacyFindings(c: Casefile): RedactionRecord[] {
  if (!validateCasefile(c).valid) throw new Error('Cannot scan an invalid casefile.');
  return scan(c);
}
export function redactCasefile(
  c: Casefile,
  options: { pointers?: string[] } = {},
): { casefile: Casefile; findings: RedactionRecord[]; changed: boolean } {
  const findings = privacyFindings(c);
  for (const pointer of options.pointers ?? []) {
    if (!pointer.startsWith('/') || !pointerParts(pointer) || pointer.startsWith('/redactions'))
      throw new Error(
        'Custom redactions require a valid non-root JSON pointer outside the redaction ledger.',
      );
    if (!getPointer(c, pointer).found)
      throw new Error('A custom redaction pointer does not exist. No output was written.');
    addFinding(findings, { pointer, reason: 'explicit redaction' });
  }
  const byPointer = new Map(findings.map((f) => [f.pointer, f]));
  const unique = [...byPointer.values()].filter((f) => {
    for (
      let slash = f.pointer.indexOf('/', 1);
      slash !== -1;
      slash = f.pointer.indexOf('/', slash + 1)
    ) {
      if (byPointer.has(f.pointer.slice(0, slash))) return false;
    }
    return true;
  });
  const copy = JSON.parse(JSON.stringify(c)) as Casefile;
  for (const finding of unique) {
    const parts = pointerParts(finding.pointer)!;
    let parent: unknown = copy;
    for (const part of parts.slice(0, -1)) parent = (parent as Record<string, unknown>)[part];
    (parent as Record<string, unknown>)[parts.at(-1)!] = REDACTED;
  }
  if (unique.length) {
    const ledger = new Map([...(copy.redactions ?? []), ...unique].map((r) => [r.pointer, r]));
    if (ledger.size > 10000)
      throw new Error(
        'Redaction ledger exceeds 10000 entries. Split or minimize this recording before exporting.',
      );
    copy.redactions = [...ledger.values()];
  }
  if (!validateCasefile(copy).valid)
    throw new Error(
      'Redaction would invalidate structural fields or exceed casefile limits. Remove sensitive structural metadata or minimize this recording locally before exporting.',
    );
  return { casefile: copy, findings: unique, changed: unique.length > 0 };
}
export function containsRedaction(v: unknown): boolean {
  return (
    v === REDACTED ||
    (typeof v === 'string' && v.includes(REDACTED)) ||
    (v !== null && typeof v === 'object' && Object.values(v).some(containsRedaction))
  );
}
export function redactionIntersects(c: Casefile, pointer: string): boolean {
  return (c.redactions ?? []).some(
    (r) =>
      r.pointer === pointer ||
      r.pointer.startsWith(pointer + '/') ||
      pointer.startsWith(r.pointer + '/'),
  );
}
export function jsonEqual(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]!));
  const left = a as Record<string, Json>,
    right = b as Record<string, Json>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((k) => Object.hasOwn(right, k) && jsonEqual(left[k]!, right[k]!))
  );
}

export function pointerTouchesMarker(value: unknown, pointer: string): boolean {
  const parts = pointerParts(pointer);
  if (!parts) return false;
  let current = value;
  for (const part of parts) {
    if (typeof current === 'string' && current.includes(REDACTED)) return true;
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, part))
      return false;
    current = (current as Record<string, unknown>)[part];
  }
  return containsRedaction(current);
}
