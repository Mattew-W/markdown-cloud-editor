# API design conventions

This document establishes conventions for the planned HTTP API. Route names and payloads below are proposals; update them with the team when implementation decisions are made.

## General

- Use `/api/v1` as the versioned API prefix.
- Exchange JSON unless an endpoint explicitly handles Markdown text or another media type.
- Use standard HTTP methods and status codes. Return a consistent error object, for example `{ "error": { "code": "...", "message": "..." } }`; do not expose stack traces, SQL, tokens, or internal secrets.
- Validate inputs on the server. Define request size limits and pagination for collection endpoints.
- Authenticate protected requests with `Authorization: Bearer <access-token>`. Do not put JWTs in URLs. Enforce document ownership/authorization on every read and write, not only in the UI.
- Use TLS in deployed environments and avoid logging credentials or full bearer tokens.

## Proposed resource routes

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/api/v1/auth/register` | Create an account, if self-registration is enabled |
| POST | `/api/v1/auth/login` | Authenticate and issue a token |
| GET | `/api/v1/documents` | List documents visible to the caller |
| POST | `/api/v1/documents` | Create a document |
| GET | `/api/v1/documents/{id}` | Fetch a document and its revision metadata |
| PUT | `/api/v1/documents/{id}` | Update a document, with concurrency protection |
| DELETE | `/api/v1/documents/{id}` | Delete a document, subject to retention policy |

These are illustrative starting points, not implemented endpoints. Agree on names and response shapes before parallel modules depend on them.

## Error and concurrency handling

Use appropriate status codes such as `400` for invalid input, `401` for missing/invalid authentication, `403` for forbidden access, `404` for unavailable resources, `409` for a version conflict, and `500` for unexpected server errors. Consider an `ETag`/`If-Match` or explicit revision field for updates. Reject stale writes with `409` or `412` so autosave cannot silently overwrite newer content.

## Contract changes

Document fields, nullability, limits, auth requirements, and error behavior for each endpoint. Coordinate breaking changes across frontend and backend, and update API tests and this document in the same PR.
