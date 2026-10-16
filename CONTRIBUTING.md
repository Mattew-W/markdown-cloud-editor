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

Each PR needs approval from at least one other team member. Authors must not approve their own PR. Resolve every review conversation and address requested changes before merging. The author should request review from a teammate; the reviewer should check the code review checklist in [docs/CODE_REVIEW.md](docs/CODE_REVIEW.md).

Only repository maintainers should administer branch rules. Merge using an allowed GitHub merge method after all requirements are satisfied. Do not force-push to shared branches. Feature branches should be deleted after merge when practical.

## Local checks

From each Rust crate or workspace directory, run:

```sh
cargo fmt --check
cargo clippy -- -D warnings
cargo test
```

Run any frontend checks documented by the frontend package as well. CI discovers Cargo manifests automatically; the team should add frontend checks when a frontend test/lint tool is selected.
