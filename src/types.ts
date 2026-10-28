/** JSON data only: casefiles never contain executable assertions or tool adapters. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export const EVENT_KINDS = [
  'model.request',
  'model.response',
  'tool.call',
  'tool.result',
  'run.end',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export type Outcome = 'success' | 'error' | 'cancelled';
interface BaseEvent {
  id: string;
  atMs: number;
  data: Json;
}
export type BoundaryEvent =
  | (BaseEvent & { kind: 'model.request' | 'model.response'; callId: string })
  | (BaseEvent & { kind: 'tool.call'; callId: string; name: string })
  | (BaseEvent & { kind: 'tool.result'; callId: string; outcome: 'success' | 'error' | 'timeout' })
  | (BaseEvent & { kind: 'run.end'; outcome: Outcome });
interface AssertionBase {
  id: string;
  description?: string;
}
export type Assertion =
  | (AssertionBase & { kind: 'event.exists'; eventKind: EventKind })
  | (AssertionBase & { kind: 'event.count'; eventKind: EventKind; equals: number })
  | (AssertionBase & { kind: 'value.equals'; eventId: string; pointer: string; expected: Json })
  | (AssertionBase & { kind: 'value.absent'; eventId: string; pointer: string })
  | (AssertionBase & { kind: 'calls.settled'; boundary: 'tool' | 'model' | 'all' })
  | (AssertionBase & { kind: 'run.outcome'; equals: Outcome });
export interface RedactionRecord {
  pointer: string;
  reason: string;
}
export interface Casefile {
  format: 'agent-casefile';
  version: '1.0';
  id: string;
  title: string;
  description?: string;
  createdAt: string;
  provenance: { kind: 'synthetic' | 'recorded'; source?: string; notes?: string };
  environment: {
    runtime: string;
    framework?: { name: string; version: string };
    model?: { provider: string; name: string };
  };
  capture: { status: 'complete' | 'partial'; missing: string[] };
  events: BoundaryEvent[];
  assertions: Assertion[];
  redactions?: RedactionRecord[];
}
export interface Diagnostic {
  severity: 'error' | 'warning';
  code: string;
  path: string;
  message: string;
}
export interface ValidationResult {
  valid: boolean;
  diagnostics: Diagnostic[];
  casefile?: Casefile;
}
export interface AssertionResult {
  id: string;
  kind: Assertion['kind'];
  status: 'pass' | 'fail' | 'inconclusive';
  message: string;
}
export interface ReplayReport {
  mode: 'offline';
  casefileId: string;
  status: 'pass' | 'fail' | 'inconclusive';
  counts: { pass: number; fail: number; inconclusive: number };
  assertions: AssertionResult[];
  diagnostics: Diagnostic[];
}
