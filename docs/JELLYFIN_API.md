# Jellyfin API usage

## Endpoints used

- `System/Info/Public`
- `Users/AuthenticateByName`
- `Users/AuthenticateWithQuickConnect`
- `QuickConnect/Initiate`
- `Users/{userId}`
- `Users/{userId}/Views`
- `Users/{userId}/Items`
- `Users/{userId}/Items/Resume`
- `Users/{userId}/Items/Resume` (Next Up fallback)
- `Items/{itemId}/PlaybackInfo`
- `Sessions/Playing`
- `Sessions/Playing/Progress`
- `Sessions/Playing/Stopped`

## Authentication

`authenticateByName` posts `Username` and `Pw`.
`authenticateWithQuickConnect` posts `{ Secret }`.

## Session handling

- Server URL validation occurs during startup and server screen flow.
- Server identity is read from `System/Info/Public`.
- Session is restored by stored `serverId` + `userId`, then verified via `Users/{userId}`.
- Session tokens are only sent in request headers.

## Playback info

Playback uses `Items/{itemId}/PlaybackInfo` with a default device profile including transcode limits.

## Error handling

`api/http/http.ts` maps HTTP status and transport failures into typed errors and retries timeouts/unreachables with bounded retries.
