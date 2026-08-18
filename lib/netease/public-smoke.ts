import { NeteaseClient } from "./index.ts";

const playlistId = process.argv[2];
const expectedOwnerUid = process.argv[3];
if (!playlistId || !/^\d+$/.test(playlistId)) {
  throw new Error("Usage: npm run smoke:public -- <public-playlist-id> [expected-owner-uid]");
}
if (expectedOwnerUid && !/^\d+$/.test(expectedOwnerUid)) {
  throw new Error("expected-owner-uid must be numeric");
}
const playlist = await new NeteaseClient({ retryCount: 0 }).getPlaylistDetail(playlistId);

if (playlist.id !== playlistId || (expectedOwnerUid && playlist.userId !== expectedOwnerUid)) {
  throw new Error("Public playlist identity does not match the explicit smoke-test arguments");
}
if (playlist.trackCount <= 0 || playlist.trackIds.length <= 0) {
  throw new Error("Public playlist response is unexpectedly empty");
}

console.log(JSON.stringify({
  id: playlist.id,
  name: playlist.name,
  ownerUid: playlist.userId,
  privacy: playlist.privacy,
  declaredTrackCount: playlist.trackCount,
  anonymousTrackIds: playlist.trackIds.length,
  embeddedDetails: playlist.embeddedTracks.length,
  declaredCloudTrackCount: playlist.cloudTrackCount,
}, null, 2));
