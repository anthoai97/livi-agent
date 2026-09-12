# Livi

An interior design chat agent built with React, Node.js, Gemini, and SQLite. Browse catalog products and connect Studio to edit room objects. General chat works without Studio.

## Run locally

Requires Node 24+ and pnpm 10.17.0.

```sh
pnpm install --frozen-lockfile
cp -n .env.example .env
# Set GEMINI_API_KEY in .env
pnpm dev
```

Open http://127.0.0.1:5173. For the built app, run `pnpm build` then `pnpm start` and open http://127.0.0.1:3001.

Optional settings in `.env`:

- `CATALOG_DATABASE_URL`: enable catalog search.
- `STUDIO_ALLOWED_ORIGINS`: allow your Studio origin, then connect Studio and click **Attach design**.
- `LIVI_DEBUG=1`: show readable agent execution steps in the terminal. Leave `LIVI_DEBUG_PROMPTS` unset to avoid raw request dumps.

Restart the server after changing `.env`. This prototype is intended for local use and has no login.

## Checks

```sh
pnpm check
pnpm test
```

## Documentation

- [Architecture](docs/Architect.md)
- [Studio integration](docs/Studio-Contract.md)
- [Catalog search](docs/Catalog-Search.md)
- [PI provenance](docs/PI-Provenance.md)
