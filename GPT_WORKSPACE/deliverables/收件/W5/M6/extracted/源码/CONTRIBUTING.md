# Contributing

## Branches

1. Update your local `main` from `origin/main` before starting work.
2. Create a branch from that updated `main`:
   - `feature/<short-description>` for a feature
   - `fix/<short-description>` for a bug fix
   - `docs/<short-description>` for documentation
3. Do not push directly to `main`. Push your branch and open a pull request targeting `main`.

```sh
git switch main
git pull --ff-only origin main
git switch -c feature/short-description
```

## Commits

Use concise, imperative commit subjects that describe the change. Keep each commit focused. Do not include secrets, local `.env` files, build output, or unrelated formatting changes.

## Pull requests

- Explain the change, its motivation, and how it was checked.
- Link related issues or design decisions when available.
- Update documentation and tests when behavior changes.
- Keep the PR focused and respond to review comments.
- Ensure the branch is current with `main` and all required Actions checks pass.

## Review and merge

The repository owner is the sole GitHub maintainer. A second GitHub approval is not required. The author reviews the diff, checks the test evidence, resolves all review conversations, and records the review conclusion in the PR before merging. AI review may help find issues, but it does not count as another user's approval.

Only repository maintainers should administer branch rules. Merge using an allowed GitHub merge method after all requirements are satisfied. Do not force-push to shared branches. Feature branches should be deleted after merge when practical.

## Local checks

From each Rust crate or workspace directory, run:

```sh
cargo fmt --check
cargo clippy -- -D warnings
cargo test
```

The current frontend draft module has a Node.js built-in test suite. From the repository root, run:

```sh
node --test "GPT_WORKSPACE/deliverables/收件/W1/M6/正式模块草案_frontend/tests/unit/drafts.test.js"
```

The `Frontend checks` workflow runs this suite when the test file exists in the branch. It reports an explicit skip while the module has not yet been added. Rust checks become required when a Rust crate and a real Rust CI job are present.
