# Code review checklist

## Behavior and design

- [ ] Does the change meet the stated requirement and fit the agreed design?
- [ ] Are edge cases and failure paths handled clearly?
- [ ] Are API fields, status codes, validation, and error shapes consistent with the shared contract?

## Rust and maintainability

- [ ] Is the Rust code idiomatic and understandable, with errors handled rather than silently ignored?
- [ ] Are `cargo fmt --check`, Clippy, and relevant tests passing in CI?
- [ ] Are dependencies necessary, maintained, and appropriately configured?

## Security and data

- [ ] Are database queries parameterized and scoped to the authenticated user's permissions?
- [ ] Are authorization checks enforced on the server for every protected operation?
- [ ] Are secrets, credentials, tokens, and sensitive content kept out of code and logs?
- [ ] Are schema changes, migrations, indexes, constraints, and transaction boundaries safe?

## Reliability and editing

- [ ] Are network errors, timeouts, malformed input, and server errors handled usefully?
- [ ] Could autosave overwrite a newer revision or lose edits? Is stale-write detection/recovery covered?
- [ ] Are retries safe and idempotent where needed?

## Verification and communication

- [ ] Are necessary unit/integration/frontend tests added or updated?
- [ ] Are setup, API, database, or user-facing docs updated where needed?
- [ ] Does the PR explain how it was verified and identify any known limitation?
- [ ] Have all review conversations been resolved and requested changes addressed?
