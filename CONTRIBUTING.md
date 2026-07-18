# Contributing

KwikEmail requires Node 24 and Docker Compose v2.

Before opening a pull request, run:

```bash
cd packages/backend
npm ci
npm test
npm run typecheck
npm run db:migrate:local
npx wrangler deploy --dry-run

cd ../frontend
npm test

cd ../..
docker compose config --quiet
docker compose build
```

Every behavior change requires a test. Keep changes minimal, preserve the 1 MiB proxy body limit and 65-second Worker timeout, and never commit `.env`, `.env.*` except `.env.example`, `/data`, `/.data`, Wrangler profiles, SQLite files, credentials, or real email.

Production Worker deployment is managed by the web setup wizard. `packages/backend/wrangler.toml` is only for local development.
