# Trackline backend only

This folder is a standalone Node.js/Express + Socket.IO application. It does not need the Vite frontend or `dist/` to run. The repository-root scripts still work for local development.

## Deploy just the backend

Use a host that runs a **persistent Node.js process** and supports WebSockets, with access to a MariaDB/MySQL database. Set the deployment's root directory to `server/` (or upload only this folder), use Node.js 20 or newer, and configure:

```text
Install command: npm install --omit=dev
Start command:   npm start
Health check:    /api/health
```

Set the environment variables shown in [`.env.example`](.env.example) in your hosting dashboard. In particular, set `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, a unique long `JWT_SECRET`, and `WEB_ORIGIN` to the frontend's exact origin (for example, `https://app.example.com`). The host's `PORT` is used automatically; `API_PORT` still works for the existing local setup. Do not upload a real `.env` file or expose database/JWT secrets to the frontend.

The database must already be reachable from the backend host. To set up a new database, first verify the credentials and run the migration **once**, after reviewing its development seed behavior:

```bash
npm run db:check
npm run db:migrate
```

For an existing database that only needs the Main Gate schema update, back up the database first, then use `npm run db:migrate:main-gate` instead of reseeding. Migrations are **not** run automatically on application startup.

## Connect a separately hosted frontend

Set these variables when building the Vite frontend, then redeploy it:

```text
VITE_API_URL=https://api.example.com/api
VITE_SOCKET_URL=https://api.example.com
```

`VITE_API_URL` includes `/api`; `VITE_SOCKET_URL` is the backend origin without `/api`. The frontend origin must match the backend's `WEB_ORIGIN`. Both public sites should use HTTPS. If the frontend and API share one origin behind a reverse proxy, leave these Vite variables unset and proxy `/api` and `/socket.io` to the backend.

For local backend-only testing, from this folder run `npm install`, copy `.env.example` to `.env`, fill in your own values, then `npm start`. Visit `http://localhost:4000/api/health` after the database is ready. `npm test` runs the backend unit tests; live API checks require `TEST_API_URL`.
