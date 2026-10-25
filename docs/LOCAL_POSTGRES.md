# Local PostgreSQL setup

This project uses PostgreSQL 17. Keep local credentials in .env; never commit real passwords or signing keys.

## Install and start PostgreSQL

Install PostgreSQL 17 using the official installer for your operating system. On Windows, find the service name selected during installation:

    Get-Service *postgres*

Start the service using that name. Make sure PostgreSQL client tools (psql and createdb) are available in PATH, or add the installation's bin directory to the current shell's PATH.

## Create local databases

Create an application database and a separate test database. Use a local PostgreSQL role with permissions on both databases:

    CREATE ROLE markdown_editor LOGIN PASSWORD '<choose-a-local-password>';
    CREATE DATABASE markdown_editor OWNER markdown_editor;
    CREATE DATABASE markdown_editor_test OWNER markdown_editor;

Run these statements using psql as a PostgreSQL administrator.

## Configure the application

From the repository root, copy the sample environment file and edit it:

    Copy-Item .env.example .env

Set DATABASE_URL to the application database and replace JWT_SECRET with a high-entropy random value of at least 32 bytes. The sample values are placeholders and the application rejects the placeholder JWT secret.

For example:

    DATABASE_URL=postgres://markdown_editor:<password>@localhost:5432/markdown_editor
    JWT_SECRET=<random-secret-of-at-least-32-bytes>

## Apply the schema

From the repository root:

    psql -h localhost -U markdown_editor -d markdown_editor -v ON_ERROR_STOP=1 -f migrations/0001_init.sql

Enter the local database password at the prompt. The migration uses the project's numbered naming convention.

## Run database-backed tests

Set TEST_DATABASE_URL to the dedicated test database, then run:

    $env:TEST_DATABASE_URL = "postgres://markdown_editor:<password>@localhost:5432/markdown_editor_test"
    cargo test --locked --all-targets -- --ignored

The integration tests create isolated schemas inside this database and clean them up through the CI workflow. Do not point TEST_DATABASE_URL at production or a database containing user data.
