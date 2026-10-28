# Agent Casefile

**Make agent failures inspectable. Keep the evidence. Carry the regression check.**

Agent Casefile turns recorded model and tool boundaries into a small, versioned JSON file you can inspect locally, review for sensitive data, and export as an offline Node.js test.

It is for the moment when “the agent got stuck” needs to become a concrete report: **which boundary, which recorded state, which expectation failed, and which evidence is missing?**

[中文快速开始](docs/README.zh-CN.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [MIT license](LICENSE)

> **Offline means offline.** Checks evaluate the recording you supply. They do not call a model, execute a recorded tool, rerun your application, establish root cause, or prove a code change fixed a bug.

## Try it in a minute

Requires **Node.js 22.18 or newer**. This is a source release; there is no published npm package yet.

```bash
git clone https://github.com/zhangjh024/agent-casefile.git
cd agent-casefile
npm ci
npm run build

# Inspect the original synthetic timeout example locally.
npm run demo
```

Open the localhost address printed in your terminal (default: `http://127.0.0.1:4317`). Select an event to see its recorded payload, examine the failed assertion, preview privacy findings, or load your own casefile from disk. Browser-loaded files stay in the browser; the inspector does not upload them.

Prefer the terminal?

```bash
node dist/cli.js validate examples/tool-timeout.casefile.json
node dist/cli.js replay examples/tool-timeout.casefile.json
```

The replay intentionally fails `ui-stops-spinning`: the tool timed out, but the recorded UI state is still `running`. The run itself correctly records `error`. That distinction is the point.

## What you get

- **One portable format.** Versioned JSON with provenance, environment, model/tool boundary events, capture gaps, and declarative assertions.
- **Evidence-aware checks.** Invalid input, incomplete captures, failed expectations, and redaction-related uncertainty are not presented as the same result.
- **A local inspector.** Timeline, event payloads, assertions, completeness diagnostics, and privacy preview without an account or hosted service.
- **Review before sharing.** Preview suspected sensitive fields and supported text patterns; redact them automatically or select explicit JSON pointers.
- **A portable regression artifact.** Export a redacted casefile and a fixed, dependency-free Node.js test runner. No uploaded scripts, custom JavaScript assertions, or recorded tools are executed.
- **A small TypeScript capture API.** Wrap model/tool calls in your own application to record the boundaries you choose. No automatic environment-variable collection or background tracing.

The application has **zero runtime npm dependencies**. TypeScript and Node types are development dependencies.

## The workflow

```text
Capture chosen boundaries → validate evidence → inspect expectations
                                 ↓
                         preview & redact
                                 ↓
                   share a casefile + offline test
```

1. **Capture** a failing run using the API below, or adapt existing logs into the JSON format.
2. **Validate** the recording. Resolve malformed data; keep genuine capture gaps explicitly marked.
3. **Assert** the behavior that should have been observed at a recorded boundary.
4. **Review privacy** before exporting. Automated redaction is a heuristic, not a guarantee.
5. **Export** the evidence and check into an issue, test fixture, or your own regression suite.
6. After changing your application, **run your application again and capture fresh evidence**. Evaluate that new recording against the relevant expectations. Editing a fixture is not a live rerun.

## CLI

All commands below work after `npm run build`. `npm run casefile -- <command>` is an equivalent wrapper.

| Command                                                | Purpose                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------- |
| `validate <file> [--json]`                             | Validate the schema and report capture/completeness warnings. |
| `replay <file> [--json]`                               | Evaluate declarative assertions against recorded data only.   |
| `compare <before> <after> [--json]`                    | Compare two recordings; this does not establish causality.    |
| `redact <file> [--pointer <pointer>]`                  | Preview privacy findings without printing raw payloads.       |
| `redact <file> --out <new-file> [--pointer <pointer>]` | Write a redacted casefile.                                    |
| `export <file> --out <new-directory>`                  | Export a redacted recording and standalone Node test.         |
| `inspect [file] [--port <number>]`                     | Start the localhost-only inspector.                           |

**Exit codes:** `0` success/pass, `1` failed assertions, `2` invalid input/usage/I/O error, `3` inconclusive evidence.

### Review and export

```bash
# Findings identify locations/categories, not the detected values.
node dist/cli.js redact examples/tool-timeout.casefile.json

# Optional: include a known sensitive field the heuristics cannot recognize.
node dist/cli.js redact examples/tool-timeout.casefile.json \
  --pointer /events/0/data/messages/0/content \
  --out /tmp/reviewed.casefile.json

# Use a new output directory; existing artifacts are not overwritten.
node dist/cli.js export examples/tool-timeout.casefile.json \
  --out /tmp/timeout-regression
cd /tmp/timeout-regression
node --test regression.test.mjs
```

The timeout export is expected to contain a failing test. Exporting does not “fix” the recording. If redaction removes evidence an assertion needs, the check must not be interpreted as proof of a pass.

Treat the export as sensitive until you have reviewed it. Names, prompts, proprietary outputs, identifiers, and unusual credentials can evade pattern-based detection. Retain the unredacted original privately if your policies permit it.

## Capture from your own code

The recorder wraps **functions you supply in your application**. The CLI and inspector never execute functions from a casefile.

```js
import { createRecorder, replayCasefile } from './dist/index.js';

const recorder = createRecorder({
  id: 'support-lookup-001',
  title: 'Support lookup boundary capture',
  environment: { runtime: `Node.js ${process.version}` },
  provenance: { kind: 'recorded', notes: 'Local capture of an explicit test call.' },
  assertions: [
    { id: 'calls-complete', kind: 'calls.settled', boundary: 'all' },
    { id: 'run-succeeded', kind: 'run.outcome', equals: 'success' },
  ],
});

// Replace the handler with your application function. This example has no network call.
const result = await recorder.tool('lookup_ticket', { ticketId: 'TICKET-DEMO-42' }, async () => ({
  status: 'resolved',
}));

const casefile = recorder.finish('success', { result });
console.log(replayCasefile(casefile));
```

Use `recorder.model(input, handler)` for an explicitly wrapped model boundary. A successful wrapper call does not validate a provider's SDK behavior; it records the JSON boundary data your handler returns. Handle application errors normally and finish the recording with the appropriate outcome.

**Capture is opt-in, not auto-sanitized storage.** Only pass data you are authorized to record. Keep raw captures private and run the privacy review before sharing. Streaming chunks, hidden SDK state, external side effects, and unwrapped calls are not automatically captured.

### Run a fresh local capture

The hand-authored fixtures show the format. This separate example actually runs a tiny repository-owned application and captures its boundaries:

```bash
# Intentionally fails: the local recovery branch leaves toolState as running.
node examples/capture-local.mjs

# Executes the alternate recovery branch and records a fresh passing run.
node examples/capture-local.mjs --fixed

node dist/cli.js compare \
  capture-broken.local.casefile.json \
  capture-fixed.local.casefile.json
```

Both invocations execute only local demonstration functions with synthetic inputs. The tool deliberately throws a `TimeoutError`; no provider, network call, real timer timeout, or third-party SDK is involved. The `--fixed` option changes the executed local recovery branch, rather than editing an existing recording. Existing capture files are not overwritten, and `*.local.casefile.json` files are ignored by Git.

## Format at a glance

A casefile records:

| Field               | Meaning                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `format`, `version` | `agent-casefile`, `1.0`; unsupported versions are rejected.                                      |
| `provenance`        | `synthetic` or `recorded`, with optional source and notes.                                       |
| `environment`       | Explicitly provided runtime and optional framework/model identity.                               |
| `capture`           | `complete` or `partial`, plus known missing evidence.                                            |
| `events`            | Ordered `model.request`, `model.response`, `tool.call`, `tool.result`, and `run.end` boundaries. |
| `assertions`        | Fixed declarative checks; no scripts or regular expressions.                                     |
| `redactions`        | Locations/reasons for evidence removed before sharing.                                           |

Events have a unique `id`, elapsed `atMs`, and JSON `data`. Requests/results are paired with `callId`. A `run.end` records the terminal outcome. The validator checks structure and diagnoses capture gaps; `capture.status: "complete"` is an author declaration, not independent proof that everything was captured.

### Supported assertions

| Kind            | Check                                                                    |
| --------------- | ------------------------------------------------------------------------ |
| `event.exists`  | At least one event of a specified kind is recorded.                      |
| `event.count`   | The number of events of a kind equals an expected count.                 |
| `value.equals`  | A JSON pointer within a named event equals an expected JSON value.       |
| `value.absent`  | A JSON pointer within a named event is not present.                      |
| `calls.settled` | Recorded model/tool calls have corresponding recorded responses/results. |
| `run.outcome`   | The recorded terminal run outcome matches an expectation.                |

`value.*` pointers are relative to the event: `/data/ui/toolState`, for example. Redaction pointers are relative to the whole casefile: `/events/6/data/ui/toolState`. They use [JSON Pointer (RFC 6901)](https://www.rfc-editor.org/rfc/rfc6901) escaping, not JSONPath.

See the [JSON Schema](schema/casefile.schema.json), [TypeScript types](src/types.ts), and [examples](examples/) for complete files. The runtime also checks cross-references, ordering, and bounded JSON safety that JSON Schema alone cannot establish.

**Intake limits:** 5 MiB of serialized UTF-8 JSON, depth 32, 100,000 JSON nodes, 10,000 events, and 1,000 assertions. A single string is limited to 131,072 UTF-16 code units. Privacy scans stop with an actionable error above 5,000 findings; minimize or split larger traces before sharing.

## Examples and their evidence level

Every shipped fixture is **original, synthetic, and hand-authored**. No production data, copied issue attachment, or third-party reproduction is included.

| Fixture                                                                         | Demonstrates                                                                                                                  |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [`tool-timeout.casefile.json`](examples/tool-timeout.casefile.json)             | A timeout is captured, but the final UI snapshot remains `running`; one intended failure.                                     |
| [`tool-timeout-fixed.casefile.json`](examples/tool-timeout-fixed.casefile.json) | A synthetic alternate recording with the expected UI state. The filename is illustrative: no implementation fix was executed. |
| [`error-shape.casefile.json`](examples/error-shape.casefile.json)               | A captured error is missing its expected structured name.                                                                     |
| [`incomplete.casefile.json`](examples/incomplete.casefile.json)                 | A partial capture lacks the tool result and terminal event.                                                                   |

```bash
node dist/cli.js compare \
  examples/tool-timeout.casefile.json \
  examples/tool-timeout-fixed.casefile.json
```

The comparison shows differences between recordings, not a proof of root cause or a measured framework compatibility result.

## Scope and non-goals

This first release is deliberately small. It is **not** a tracing backend, an agent framework, a provider simulator, a sandbox for arbitrary reproductions, or a guarantee of deterministic live model behavior. There is no hosted storage, telemetry, account system, or built-in live rerun.

A passing offline check says that the supplied, available recording satisfies the chosen assertions. It says nothing about unrecorded behavior or the next live run. For code-level regression protection, integrate fresh capture into your application tests and assert against that new evidence.

## Development

```bash
npm ci
npm run check      # strict typecheck, build, and local tests
```

Please send focused changes with original fixtures and tests. Start with [CONTRIBUTING.md](CONTRIBUTING.md). No scheduled workflows or background services are required.

## License

[MIT](LICENSE). The shipped examples are original project fixtures under the same license.
