# Holy Sheet

Standalone document pages for the Aplyd productivity suite. This first vertical slice implements **HOLY-1 document pages** and **HOLY-2 search**.

## Included

- Workspace → space → page → subpage hierarchy
- Create a page in an existing space or create a new space inline
- Stable block IDs and paragraph, heading, bullet, numbered, and checklist blocks
- 700 ms autosave with visible saved, failure/retry, and optimistic-conflict states
- Permanent page URLs (`/pages/:id`)
- `Cmd/Ctrl+K` full-text search with phrase/prefix matching, space filter, previews, ranking, and keyboard navigation
- PostgreSQL relational schema with JSON block content and search indexes
- Local zero-setup demo store for development

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. Run `npm test`, `npm run typecheck`, and `npm run build` before shipping.

## Persistence and identity

The checked-in schema at `db/001_initial.sql` is the production data model. The UI currently uses the in-process demo repository so it can be evaluated without services; it resets when the server restarts. Before deployment, connect the API handlers to PostgreSQL and the suite identity provider. Every page read and search query must include a membership/owner/grant predicate—indexes accelerate results but never grant access.

Pages are private by default. `version` is used for optimistic concurrency: a stale writer receives HTTP 409 instead of overwriting newer content.

## SHO integration contract

SHO can launch the same create-page flow with an optional source task ID, then retain the returned Holy Sheet page ID and permanent URL. The page always belongs to one selected Holy Sheet workspace and space; users may create a new space during the flow. SHO does not own or duplicate document content.
