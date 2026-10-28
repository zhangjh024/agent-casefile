# Security and privacy

Agent traces can contain credentials, personal data, proprietary prompts, and tool outputs. Treat a raw casefile as sensitive.

## Data handling

- The CLI reads local files. Offline checks do not call models or execute recorded tools.
- The inspector binds to localhost. A file chosen in the browser is processed there, not uploaded to the server.
- The capture API records only the boundaries explicitly wrapped by your application. Raw captures are not automatically safe to share.
- No account, telemetry, hosted storage, or background synchronization is required.
- Export uses fixed project-owned runner code and data-only assertions. A casefile cannot supply code to execute.

These properties do not protect you from other software on your machine or from sharing an unreviewed export. Do not expose the inspector through a public tunnel or reverse proxy when viewing sensitive data.

## Redaction is a review aid

Automatic rules recognize selected sensitive key names and text patterns. They can miss unknown credentials, names, proprietary content, and context-dependent personal data. Explicit JSON pointers help remove known sensitive fields, but do not replace manual review.

Review both the recording and the generated artifact before publishing. Redaction can remove information necessary for an assertion; an uncertain check is not evidence of a pass. Keep original evidence privately only when your organization's retention rules permit it.

## Untrusted casefiles

Only JSON is accepted; assertions are from a fixed declarative set. Input limits and strict validation reduce malformed-input risks. Neither validation nor offline evaluation makes a casefile's narrative, provenance, timestamps, or declared completeness trustworthy: those are author-supplied claims.

Do not execute third-party reproduction scripts just because they accompany a casefile. No project command needs an account token or provider credential for the included examples.

## Reporting a problem

Please do not publish a real secret or private trace in an issue. For a non-sensitive bug, submit a minimal synthetic example describing the problem and expected behavior.

If GitHub private vulnerability reporting is enabled for this repository, use its **Security → Report a vulnerability** flow. Otherwise, open a minimal issue asking for a private contact without including exploit details, credentials, or affected private data. No dedicated private reporting address is configured in this initial release.
