import type { Assertion, BoundaryEvent, Casefile, Json, Outcome } from './types.js';
import { isJson, validateCasefile } from './validation.js';
export interface RecorderOptions {
  id: string;
  title: string;
  description?: string;
  environment: Casefile['environment'];
  provenance?: Casefile['provenance'];
  assertions?: Assertion[];
}
function snapshot<T>(value: T): T {
  if (!isJson(value))
    throw new Error(
      'Boundary capture accepts bounded JSON values only. Normalize data before recording it.',
    );
  return JSON.parse(JSON.stringify(value)) as T;
}
function errorData(error: unknown): Json {
  if (error instanceof Error)
    return { error: { name: error.name.slice(0, 256), message: error.message.slice(0, 8192) } };
  return {
    error: {
      name: 'ThrownValue',
      message: typeof error === 'string' ? error.slice(0, 8192) : 'A non-Error value was thrown.',
    },
  };
}
/** Explicit opt-in wrappers. Functions run in the caller's application, never from a casefile. */
export function createRecorder(options: RecorderOptions) {
  const started = performance.now();
  const createdAt = new Date().toISOString();
  const settings = snapshot(options);
  const events: BoundaryEvent[] = [];
  const missing: string[] = [];
  let sequence = 0,
    calls = 0,
    pending = 0,
    finished = false;
  const time = () => Math.round((performance.now() - started) * 1000) / 1000;
  const eventId = () => `event-${++sequence}`;
  const checkOpen = () => {
    if (finished)
      throw new Error('This recorder is finished. Create a new recorder for another run.');
  };
  const run = async <Input extends Json, Output extends Json>(
    boundary: 'model' | 'tool',
    name: string | undefined,
    input: Input,
    handler: (input: Input) => Output | Promise<Output>,
  ): Promise<Output> => {
    checkOpen();
    const data = snapshot(input);
    const callId = `${boundary}-${++calls}`;
    if (boundary === 'tool' && (!name || name.length > 128))
      throw new Error('Tool names must contain 1–128 characters.');
    events.push(
      boundary === 'tool'
        ? { id: eventId(), kind: 'tool.call', atMs: time(), callId, name: name!, data }
        : { id: eventId(), kind: 'model.request', atMs: time(), callId, data },
    );
    pending++;
    try {
      const output = await handler(input);
      let captured: Json = null;
      try {
        captured = snapshot(output);
      } catch {
        missing.push(`Non-JSON output was not captured for ${callId}.`);
      }
      events.push(
        boundary === 'tool'
          ? {
              id: eventId(),
              kind: 'tool.result',
              atMs: time(),
              callId,
              outcome: 'success',
              data: captured,
            }
          : { id: eventId(), kind: 'model.response', atMs: time(), callId, data: captured },
      );
      return output;
    } catch (error) {
      const data = errorData(error);
      events.push(
        boundary === 'tool'
          ? {
              id: eventId(),
              kind: 'tool.result',
              atMs: time(),
              callId,
              outcome:
                error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'error',
              data,
            }
          : { id: eventId(), kind: 'model.response', atMs: time(), callId, data },
      );
      throw error;
    } finally {
      pending--;
    }
  };
  return {
    model: <Input extends Json, Output extends Json>(
      input: Input,
      handler: (input: Input) => Output | Promise<Output>,
    ) => run('model', undefined, input, handler),
    tool: <Input extends Json, Output extends Json>(
      name: string,
      input: Input,
      handler: (input: Input) => Output | Promise<Output>,
    ) => run('tool', name, input, handler),
    finish(outcome: Outcome, data: Json = {}): Casefile {
      checkOpen();
      if (pending)
        throw new Error('Cannot finish while boundary calls are pending. Await them first.');
      const finalEvent: BoundaryEvent = {
        id: `event-${sequence + 1}`,
        kind: 'run.end',
        atMs: time(),
        outcome,
        data: snapshot(data),
      };
      const c: Casefile = {
        format: 'agent-casefile',
        version: '1.0',
        id: settings.id,
        title: settings.title,
        ...(settings.description === undefined ? {} : { description: settings.description }),
        createdAt,
        provenance: settings.provenance ?? {
          kind: 'recorded',
          notes: 'Captured through explicit application-owned boundary wrappers.',
        },
        environment: settings.environment,
        capture: { status: missing.length ? 'partial' : 'complete', missing: [...missing] },
        events: [...events, finalEvent],
        assertions: settings.assertions ?? [],
      };
      if (!validateCasefile(c).valid)
        throw new Error(
          'Recorded casefile is invalid. Check recorder metadata, assertion references, and data limits.',
        );
      finished = true;
      return snapshot(c);
    },
  };
}
