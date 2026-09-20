# Cloudflare + Neon deployment checklist

This deployment uses no new frontend npm package.

## 1. Neon

1. Create a Neon Postgres project.
2. Open the Neon SQL Editor and run `database/schema.sql`.
3. Copy the pooled connection string from Neon. Keep it private; it belongs in Cloudflare as `DATABASE_URL`.

## 2. Cloudflare Worker

1. Connect the repository in Workers & Pages.
2. Build command: `npm run build`.
3. Static asset directory: `dist`.
4. Deploy using the repository's `wrangler.jsonc` configuration. It declares the `MAKERSPACE_ROOMS` Durable Object and the `ASSETS` binding.
5. Add `DATABASE_URL` and `ADMIN_EMAILS` as encrypted Worker secrets. Do not add them as `VITE_` variables. `ADMIN_EMAILS` accepts a comma-separated list.

The Worker exposes:

- `GET /api/me` — verified Access identity used by the lobby.
- `GET /api/health` — authenticated deployment check.
- `POST /api/rooms/:code/join` — upserts the user, room, and membership in Neon.
- `GET /api/room?room=ABCD&participant=...` — authenticated WebSocket upgrade routed to the room Durable Object.

Room authorization is enforced by the Worker and the room Durable Object:

- `ADMIN_EMAILS` contains the comma-separated email addresses allowed to create rooms.
- `PRECREATED_ROOMS` preserves room codes that already exist before the first authenticated visit.
- The production administrator list is stored only in the encrypted `ADMIN_EMAILS` Worker secret; the repository preserves `7K3M` as the pre-created room.
- Administrators may create missing rooms by entering a new code. Members receive a `404` for missing rooms and can only join an existing code.
- Direct WebSocket upgrades are rejected unless the room already exists.

## 3. Google login through Access

1. In Zero Trust, add Google as an identity provider.
2. Create a self-hosted, **hostname-based** Access application for the exact Worker hostname/custom domain.
3. Add an Allow policy for the intended Google email addresses or domain.
4. Test in a private browser window. The first visit should redirect to the Google login page, then return to the makerspace lobby.

Use hostname-based Access for this app because Worker-level Access policies currently reject WebSocket upgrade requests. After login, the browser's Access cookie covers the `/api/room` upgrade on the same hostname.

The Google identity provider requires a Google OAuth Web client ID and client secret. Use the Cloudflare Access team callback URL shown in the identity-provider setup screen; never store the client secret in this repository or a `VITE_` variable.

## 4. Smoke test

After signing in:

1. Open `/api/health`; confirm `authenticated: true` and `neonConfigured: true`.
2. Enter a four-to-twelve-character room code.
3. Confirm `/api/rooms/<code>/join` returns `joined: true`.
4. Open a second private window with another allowed Google account and join the same code.
5. Verify presence, chat, cable-end claims, and voice signaling in the 3D room.
