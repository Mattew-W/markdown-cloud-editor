# Database structure and migrations

The database is planned to use PostgreSQL with `sqlx`. The schema below is a design starting point and must be reviewed against product requirements before implementation.

## Suggested entities

- `users`: primary key, unique normalized email/username as selected, password hash, creation/update timestamps. Store only a password hash produced by a suitable password hashing algorithm; never store plaintext passwords.
- `documents`: primary key, owner/user foreign key, title, Markdown body, revision number, creation/update timestamps. Add indexes to match list and ownership queries.
- Optional `document_revisions`: document foreign key, revision number, content snapshot or diff, author, and timestamp if revision history is in scope.

Use foreign keys and appropriate `NOT NULL`, `UNIQUE`, and check constraints. Define deletion and retention behavior explicitly. Keep authentication secrets out of the database unless there is a reviewed design for key rotation or token revocation.

## Migrations

- Store ordered, immutable migrations in the Rust workspace's `migrations/` directory (or the chosen `sqlx` migration location).
- Use descriptive, monotonically ordered names, such as `20261016090000_create_users.sql`.
- Add a new migration to change schema; do not rewrite a migration already applied/shared with teammates.
- Review indexes, constraints, data backfills, lock impact, and rollback/recovery implications.
- Test migrations against a disposable PostgreSQL database and keep seed/test data free of real personal data.
- Keep `DATABASE_URL` and credentials out of committed files. Use environment variables or the deployment secret store.

## Query and access safety

Use bound parameters through `sqlx`; do not concatenate user input into SQL. Scope every document query by the authenticated user's authorization. Use transactions for multi-step changes and enforce revision checks atomically to prevent autosave lost updates. Avoid returning sensitive columns from broad queries.
