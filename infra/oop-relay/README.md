# OOP relay

A personal Cloudflare Worker that lets a phone reach one OOP desktop from any network. The
desktop keeps an outbound WebSocket to the relay, and the relay forwards the phone's HTTP
requests and WebSockets over it, so no router port has to be opened. It runs on a free
`*.workers.dev` address; no domain is needed.

The wire format lives in [`packages/shared/src/oopRelayFrames.ts`](../../packages/shared/src/oopRelayFrames.ts)
and the desktop side in
[`apps/desktop/src/backend/remoteRelayTunnel.ts`](../../apps/desktop/src/backend/remoteRelayTunnel.ts).

## Deploy

From this directory, with a Cloudflare account:

```sh
npx wrangler login
npx wrangler deploy
npx wrangler secret put OOP_RELAY_SECRET
```

`deploy` prints the relay address, such as `https://oop-relay.<account>.workers.dev`. For the
secret, paste the value shown under **Use away from home** in OOP's phone dialog, then enter the
relay address there and save.

The Cloudflare account's email address must be verified first. Without it, `deploy` fails with
API code 10034 and every workers.dev subdomain is refused as invalid. On the first deploy,
wrangler asks for a workers.dev subdomain; enter only the name, such as `my-oop`.

## Notes

- One deployment serves one desktop. A desktop that reconnects replaces the previous one.
- The relay only checks the desktop's secret. Phones still sign in to the desktop with a pairing
  code, exactly as on the local network.
- Cloudflare terminates TLS, so traffic is visible to the Cloudflare account that runs the relay.
- The relay uses a SQLite-backed Durable Object with WebSocket hibernation, which fits the
  Workers free plan for personal use.

Local check: `npx wrangler dev`, set `OOP_RELAY_SECRET` in a `.dev.vars` file, and point OOP at
`http://localhost:8787`.
