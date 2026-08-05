# Star Race Server

WebSocket room server for the Star Race browser multiplayer demo.

## Run

```bash
npm install
npm start
```

The server listens on `PORT` and exposes a JSON health response at `/`.
# Supabase player saves

The server still works without Supabase and reports `"persistence":"memory"`
from its health endpoint. To enable permanent player saves:

1. Run `supabase-schema.sql` in the Supabase SQL Editor.
2. Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to the Render service.
3. Redeploy. The health endpoint will then report `"persistence":"supabase"`.

Clients send a Supabase access token in the `join` WebSocket message. The
server verifies the token with Supabase Auth, uses the authenticated user ID,
loads `total_stars`, and saves every awarded star. Never expose the service-role
key to browser code or commit it to GitHub.
