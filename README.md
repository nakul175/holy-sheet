# Holy Sheet

Standalone document pages for the Aplyd productivity suite. HOLY-1 pages and HOLY-2 search are on main. This branch develops HOLY-3 rich documents and is **not release qualified yet**.

## Included

- Workspace → space → page → subpage hierarchy
- Create a page in an existing space or create a new space inline
- Stable block IDs and paragraph, heading, bullet, numbered, and checklist blocks
- 700 ms autosave with visible saved, failure/retry, and optimistic-conflict states
- Permanent page URLs (`/pages/:id`)
- `Cmd/Ctrl+K` full-text search with phrase/prefix matching, space filter, previews, ranking, and keyboard navigation
- PostgreSQL relational schema with JSON block content and search indexes
- Durable embedded PostgreSQL for local development

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. Run `npm test`, `npm run typecheck`, and `npm run build` before shipping.

## Persistence and identity

`db/002_documents.sql` adds the rich-document schema. Production requires PostgreSQL through `DATABASE_URL`, trusted suite JWT configuration, a recovery master key, private storage and a malware scanner. Local loopback development uses a preview identity and durable PGlite at `.holy-sheet/postgres`. Preview identity and filesystem fallbacks are disabled in production. Page reads, writes, search, references, recovery and media enforce current membership and page grants. Uploads remain unavailable until validated and scanned.

The production feature flag defaults off. See [staging preparation](deployment/STAGING.md) and the [implementation checkpoint](deployment/IMPLEMENTATION-STATUS.md) for setup, missing behaviors and release gates. No staging deployment has been performed.

Pages are private by default. `version` is used for optimistic concurrency: a stale writer receives HTTP 409 instead of overwriting newer content.

## SHO integration contract

SHO can launch the same create-page flow with an optional source task ID, then retain the returned Holy Sheet page ID and permanent URL. The page always belongs to one selected Holy Sheet workspace and space; users may create a new space during the flow. SHO does not own or duplicate document content.

`/embed/pages/:id` renders the same rich editor component with reduced navigation. This is an integration surface; the actual SHO host and suite login adapter still require integration and qualification.
