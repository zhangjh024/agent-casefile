# Contributing

Thanks for helping make agent failures easier to inspect.

## Local setup

Use Node.js 22.18 or newer, then run:

```bash
npm ci
npm run check
```

`npm run demo` starts the local inspector. No credentials, provider account, or external model call is needed for the shipped examples or tests.

## Good first contributions

- A small, original synthetic case demonstrating an unclear diagnostic.
- A negative test for malformed input, missing evidence, unsafe output, or redaction uncertainty.
- An accessible inspector improvement that preserves local-only data handling.
- A documented adapter that actually captures a supported boundary, with local tests and explicit limitations.

Before a larger change, open a focused issue describing the user problem and proposed scope. Do not post private prompts, customer traces, credentials, or unreviewed logs.

## Pull request checklist

- Keep the change focused and explain the behavior before/after.
- Run `npm run check` against the final code.
- Include tests for relevant error and interrupted flows, not just the happy path.
- Label evidence honestly: synthetic example, captured local run, or independently reproduced upstream failure.
- Do not describe edited fixture data as proof that application code was fixed.
- Keep casefiles data-only. No executable assertions, arbitrary imports, or downloaded repro scripts.
- Keep runtime dependencies and network behavior minimal; discuss additions first.
- Review fixture licensing and sensitive data before copying any third-party material.

If changing the format, update validation, documentation, and tests together. Unknown fields and unsupported versions are intentionally rejected rather than silently ignored. Do not weaken that boundary just to accept a fixture.

## Project boundaries

Agent Casefile is a portable evidence-and-checking tool, not a tracing backend or live execution sandbox. Passing offline assertions cannot establish deterministic live behavior, root cause, or completeness of unrecorded state.

All shipped examples are original synthetic fixtures. Contributions are provided under the repository's MIT license; include attribution and applicable license notices for any approved third-party material.
