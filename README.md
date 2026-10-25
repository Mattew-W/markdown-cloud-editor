# Markdown Cloud Editor

A web-based Markdown editor with cloud sync, built as a university course project.

## Project status

The repository contains a Rust API built with Actix Web, PostgreSQL migrations, authentication and health endpoints, a frontend draft-storage module, and CI workflows.

Document endpoints and API rate limiting are still in progress. See the implementation status in [docs/API.md](docs/API.md) and the contracts index in [docs/README.md](docs/README.md).

## Quick start

### Requirements

- The Rust toolchain specified in Cargo.toml
- PostgreSQL 17 for the application and database-backed tests
- Node.js 24 for frontend checks

### Configure and run

1. Copy .env.example to .env.
2. Set DATABASE_URL to a local PostgreSQL database and replace JWT_SECRET with a random secret of at least 32 bytes.
3. Create the database and apply the migration as described in [docs/LOCAL_POSTGRES.md](docs/LOCAL_POSTGRES.md).
4. Start the API from the repository root:

        cargo run --locked

The default development address is http://127.0.0.1:8080.

### Checks

Run the Rust checks from the repository root:

        cargo fmt --check
        cargo clippy --locked --all-targets -- -D warnings
        cargo test --locked --all-targets
        cargo doc --locked --no-deps

Database-backed tests require TEST_DATABASE_URL and a running PostgreSQL 17 instance:

        cargo test --locked --all-targets -- --ignored

Run the frontend draft tests with Node.js:

        node --test frontend/js/tests/drafts.test.js

## Repository layout

| Path | Purpose |
| --- | --- |
| src/ | Rust API, authentication, middleware, and repositories |
| frontend/js/ | Frontend draft-storage module and tests |
| migrations/ | PostgreSQL schema and verification scripts |
| tests/ | API and database integration tests |
| docs/ | Project contracts, architecture, setup, and implementation status |
| GPT_WORKSPACE/ | Archived course submissions and review records |

See [CONTRIBUTING.md](CONTRIBUTING.md) for the branch and review process.
