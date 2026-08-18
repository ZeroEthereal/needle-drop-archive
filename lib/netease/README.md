# NetEase read-only adapter

This directory contains the smallest account-aware adapter needed by the loss
guard. It is compatible with Cloudflare Workers: only `fetch`, Web platform
types, `AbortController`, and timers are used. It does not import Node crypto,
Axios, a cookie library, or the full third-party NetEase API server.

## Security contract

- Requests can target only `https://music.163.com` or
  `https://interface.music.163.com` and `/api/**` paths.
- `NeteaseSession` keeps Cookie material in a `WeakMap`. Its JSON form is
  redacted, including when a QR-check result is serialized accidentally.
- `serializeNeteaseSession()` is the one deliberate plaintext-secret boundary.
  Pass its result directly into the Worker AES-GCM vault; never return or log it.
- Playback URLs are used only to decide account-level playability and are
  discarded before a result leaves the adapter.
- Errors exclude request headers, Cookie values, and upstream response bodies.

Typical QR route integration:

```ts
const result = await client.checkQrLogin(key);
if (result.state === "authorized" && result.session) {
  const plaintext = serializeNeteaseSession(result.session);
  await encryptedSessionStore.put(plaintext); // AES-256-GCM in the caller
  return Response.json({ state: result.state, profile: result.profile });
}
return Response.json({ state: result.state, profile: result.profile });
```

## Primary exports

- `NeteaseClient`
- `NeteaseSession`
- `serializeNeteaseSession()` / `deserializeNeteaseSession()`
- `NeteaseError`
- normalized account, playlist, cloud, song, and playback types from `types.ts`

`NeteaseClient` provides QR key/check, login status and refresh, playlist
detail, complete selected-playlist track IDs, cloud fallbacks, batch song details,
account-level playback checks, and a complete account snapshot.

## Reliability boundary

These endpoints are undocumented internal NetEase endpoints. The adapter uses
the authenticated account response itself as the source of truth:

- QR authorization is accepted after the login profile is valid and its UID
  matches the configured account; playlist failures do not discard that saved
  session;
- authenticated membership completeness, cloud `songId`/`simpleSong.id` alias
  normalization, pagination, and playback batches are validated from their
  response shapes and requested IDs;
- the service must stop without updating its baseline when any response or
  batch is incomplete;
- no public metadata field is a safe substitute for an authenticated playback
  response;
- a song is playable only when its playback item has `code = 200` and a non-empty
  `url`; a complete item without a usable URL is an unplayable observation;
- request, API, and incomplete-batch errors fail the snapshot instead of being
  converted into unplayable songs;
- a single unplayable song result is not a confirmed grey-song event—the two-day state
  machine belongs in the sync layer;
- if NetEase begins requiring WEAPI/EAPI/XEAPI for these paths, this adapter
  fails explicitly rather than embedding a large, brittle Node crypto stack or
  silently guessing availability.

Run the deterministic fake-server self-test with:

```sh
npm run test:netease
```
