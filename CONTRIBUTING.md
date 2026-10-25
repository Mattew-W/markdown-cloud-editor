# Contributing

## Branches

1. Update your local main from origin/main before starting work.
2. Create a branch from that updated main:
   - feature/<short-description> for a feature
   - fix/<short-description> for a bug fix
   - docs/<short-description> for documentation
3. Do not push directly to main. Push your branch and open a pull request targeting main.

    git switch main
    git pull --ff-only origin main
    git switch -c feature/short-description

## Commits

Use concise, imperative commit subjects that describe the change. Keep each commit focused. Do not include secrets, local .env files, build output, or unrelated formatting changes.

## Pull requests

- Explain the change, its motivation, and how it was checked.
- Link related issues or design decisions when available.
- Update documentation and tests when behavior changes.
- Keep the PR focused and respond to review comments.
- Ensure the branch is current with main and all required Actions checks pass.

## Review and merge

The repository owner is the sole GitHub maintainer. A second GitHub approval is not required. The author reviews the diff, checks the test evidence, resolves all review conversations, and records the review conclusion in the PR before merging.

Only repository maintainers should administer branch rules. Merge using an allowed GitHub merge method after all required checks pass. Do not force-push to shared branches. Feature branches should be deleted after merge when practical.

## Local checks

Run from the repository root:

    cargo fmt --check
    cargo clippy --locked --all-targets -- -D warnings
    cargo test --locked --all-targets
    cargo doc --locked --no-deps
    node --test frontend/js/tests/drafts.test.js

Database-backed tests are ignored in a normal local run. Set TEST_DATABASE_URL to a dedicated PostgreSQL 17 test database before running:

    cargo test --locked --all-targets -- --ignored

See [docs/LOCAL_POSTGRES.md](docs/LOCAL_POSTGRES.md) for database setup.
