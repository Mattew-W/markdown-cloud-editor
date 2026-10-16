# Web-based Markdown Editor with Cloud Sync

A collaborative course project for editing Markdown in the browser and syncing documents to a cloud service.

## Planned stack

- Backend: Rust with Actix Web or Rocket (framework to be selected by the team)
- Database: PostgreSQL, accessed through `sqlx`
- Frontend: HTML, CSS, and JavaScript
- Markdown rendering: a maintained library such as `marked`
- Authentication: JWT
- CI: GitHub Actions

The repository currently contains collaboration and design guidance. Application code and the final framework choice have not yet been added.

## Prerequisites

Install Rust stable with `rustup`, PostgreSQL, and Git. If the frontend later adds a JavaScript package manager, install the version specified by its package metadata.

## Configuration

Copy `.env.example` to `.env`, then set local PostgreSQL connection values. Keep `.env` private; never commit real passwords, tokens, or signing keys. The example values are placeholders and are not production credentials.

## Database

Create a local database, for example `markdown_editor`, and set `DATABASE_URL` in `.env`. The project should use versioned SQL migrations through `sqlx`. See [docs/DATABASE.md](docs/DATABASE.md).

## Run

Once the Rust application is added, run it from the directory containing its `Cargo.toml` with `cargo run` (or the framework-specific command documented by that crate). Serve the frontend using the method selected by the team. Exact commands will be added when the application layout and framework are chosen.

## Checks

GitHub Actions discovers Cargo manifests in the repository and runs `cargo fmt --check`, `cargo clippy -- -D warnings`, and `cargo test` for each discovered crate/workspace. The Rust CI job reports a clear failure until Rust code is added.

## Collaboration

Read [CONTRIBUTING.md](CONTRIBUTING.md) before working. All changes go through a pull request to `main` and require an approval from another member plus passing CI.
