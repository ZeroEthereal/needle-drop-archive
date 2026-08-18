import {
  deserializeNeteaseSession,
  NeteaseClient,
  NeteaseError,
  serializeNeteaseSession,
} from "./index.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`NetEase adapter self-test failed: ${message}`);
}

function json(body: unknown, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: responseHeaders,
  });
}

function parseBody(init?: RequestInit): URLSearchParams {
  return new URLSearchParams(typeof init?.body === "string" ? init.body : "");
}

const PLAYABLE_ID = "100000001";
const UNPLAYABLE_ID = "100000004";
const PURE_CLOUD_ID = "100000005";
const OMITTED_PLAYBACK_ID = 200000006;
const SONGS = new Map([
  [PLAYABLE_ID, "可播放歌曲"],
  ["100000002", "普通歌曲甲"],
  ["100000003", "普通歌曲乙"],
  [UNPLAYABLE_ID, "不可播放歌曲"],
  [PURE_CLOUD_ID, "纯云盘歌曲"],
]);
const PLAYLIST_SONG_IDS = [...SONGS.keys()];

async function expectNeteaseError(
  action: () => Promise<unknown>,
  kind: NeteaseError["kind"],
  message: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    assert(error instanceof NeteaseError && error.kind === kind, message);
    return;
  }
  throw new Error(`NetEase adapter self-test failed: ${message}`);
}

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  assert(url.origin === "https://interface.music.163.com", "default API origin is not the Worker-compatible host");
  const form = parseBody(init);
  const cookie = new Headers(init?.headers).get("Cookie") ?? "";

  if (url.pathname === "/api/login/qrcode/unikey") {
    return json({ code: 200, unikey: "selftest-qr-key-1234" });
  }
  if (url.pathname === "/api/login/qrcode/client/login") {
    return json(
      { code: 803, message: "authorized", cookie: "MUSIC_U=super-secret-token; __csrf=selftest-csrf" },
      { "Set-Cookie": "NMTID=selftest-device; Path=/; HttpOnly; Secure" },
    );
  }
  if (url.pathname === "/api/nuser/account/get") {
    assert(cookie.includes("MUSIC_U="), "authenticated endpoint did not receive the opaque session");
    return json({
      code: 200,
      account: { id: 10000001 },
      profile: { userId: 10000001, nickname: "测试用户", avatarUrl: "https://example.test/avatar.jpg" },
    });
  }
  if (url.pathname === "/api/login/token/refresh") {
    return json({ code: 200 }, { "Set-Cookie": "MUSIC_U=refreshed-secret-token; Path=/; HttpOnly" });
  }
  if (url.pathname === "/api/v6/playlist/detail") {
    return json({
      code: 200,
      playlist: {
        id: 20000001,
        name: "测试歌单",
        userId: 10000001,
        creator: { userId: 10000001, nickname: "测试用户" },
        privacy: 0,
        trackCount: SONGS.size,
        cloudTrackCount: 2,
        trackIds: PLAYLIST_SONG_IDS.map((id) => ({ id: Number(id) })),
        tracks: [],
        updateTime: 1_700_000_000_000,
      },
    });
  }
  if (url.pathname === "/api/user/playlist") {
    const offset = Number(form.get("offset") ?? 0);
    return json({
      code: 200,
      count: 2,
      more: offset === 0,
      playlist: offset === 0 ? [{
        id: 20000001,
        name: "测试歌单",
        userId: 10000001,
        creator: { userId: 10000001, nickname: "测试用户" },
        privacy: 1,
        trackCount: SONGS.size,
        coverImgUrl: "https://example.test/owned.jpg",
      }] : [{
        id: 20000002,
        name: "收藏歌单",
        userId: 10000002,
        creator: { userId: 10000002, nickname: "其他用户" },
        privacy: 0,
        trackCount: 3,
        coverImgUrl: "https://example.test/subscribed.jpg",
      }],
    });
  }
  if (url.pathname === "/api/v1/cloud/get") {
    return json({
      code: 200,
      count: 2,
      hasMore: false,
      data: [
        {
          songId: Number(PURE_CLOUD_ID),
          songName: "纯云盘歌曲",
          artist: "个人云盘",
          album: "云盘",
          fileName: "纯云盘歌曲.mp3",
          addTime: 1_700_000_000_000,
          simpleSong: null,
        },
        {
          songId: 100000006,
          songName: "可播放歌曲",
          artist: "测试歌手",
          album: "云盘",
          fileName: "可播放歌曲.mp3",
          addTime: 1_700_000_000_000,
          simpleSong: {
            id: Number(PLAYABLE_ID),
            name: "可播放歌曲",
            ar: [{ id: 1, name: "测试歌手" }],
            al: { id: 2, name: "测试专辑", picUrl: null },
            dt: 180_000,
          },
        },
      ],
    });
  }
  if (url.pathname === "/api/v1/cloud/get/byids") {
    return json({
      code: 200,
      data: [{ songId: Number(PURE_CLOUD_ID), songName: "纯云盘歌曲", artist: "个人云盘", album: "云盘" }],
    });
  }
  if (url.pathname === "/api/v3/song/detail") {
    const requested = JSON.parse(form.get("c") ?? "[]") as Array<{ id: number }>;
    return json({
      code: 200,
      songs: requested.flatMap(({ id }) => {
        const title = SONGS.get(String(id));
        return title && String(id) !== PURE_CLOUD_ID
          ? [{ id, name: title, ar: [{ id: 1, name: "测试歌手" }], al: { id: 2, name: "测试专辑", picUrl: null }, dt: 180_000 }]
          : [];
      }),
    });
  }
  if (url.pathname === "/api/song/enhance/player/url") {
    const requested = JSON.parse(form.get("ids") ?? "[]") as number[];
    return json({
      code: 200,
      data: requested.flatMap((id): Array<{
        id: number;
        code: number;
        url: string | null;
        fee: number;
        freeTrialInfo: null;
      }> => {
        if (id === OMITTED_PLAYBACK_ID) return [];
        if (id === Number(UNPLAYABLE_ID) || id === 200000002) {
          return [{ id, code: 404, url: null, fee: 0, freeTrialInfo: null }];
        }
        if (id === 200000001) return [{ id, code: 200, url: null, fee: 0, freeTrialInfo: null }];
        if (id === 200000003) return [{ id, code: 403, url: null, fee: 0, freeTrialInfo: null }];
        if (id === 200000004) return [{ id, code: 200, url: null, fee: 1, freeTrialInfo: null }];
        if (id === 200000005) return [{ id, code: 500, url: null, fee: 0, freeTrialInfo: null }];
        return [{ id, code: 200, url: `https://media.example.test/${id}.mp3`, fee: 0, freeTrialInfo: null }];
      }),
    });
  }
  throw new Error(`Unexpected self-test endpoint: ${url.pathname}`);
}) as typeof fetch;

export async function runNeteaseAdapterSelfTest(): Promise<void> {
  const now = 1_700_000_000_000;
  const receiverCheckingFetch = function (
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    assert(this === undefined, "fetch was invoked with the client as an illegal receiver");
    return fakeFetch(input, init);
  } as typeof fetch;
  const client = new NeteaseClient({ fetch: receiverCheckingFetch, now: () => now, retryCount: 0 });
  const challenge = await client.createQrLogin();
  assert(challenge.key === "selftest-qr-key-1234", "QR key was not normalized");
  assert(challenge.qrUrl.startsWith("https://music.163.com/login?codekey="), "QR URL is not first-party");

  const qr = await client.checkQrLogin(challenge.key);
  assert(qr.state === "authorized" && qr.session, "QR authorization did not produce an opaque session");
  const publicJson = JSON.stringify(qr);
  assert(!publicJson.includes("super-secret-token"), "JSON serialization leaked a Cookie value");
  assert(!publicJson.includes("MUSIC_U"), "JSON serialization leaked a Cookie name");

  const plaintextForVault = serializeNeteaseSession(qr.session);
  assert(plaintextForVault.includes("super-secret-token"), "explicit vault serialization lost the login secret");
  const restored = deserializeNeteaseSession(plaintextForVault);
  const refresh = await client.refreshSession(restored);
  assert(refresh.status === "refreshed" && refresh.login.state === "valid", "best-effort refresh failed");
  assert(!JSON.stringify(restored).includes("refreshed-secret-token"), "refreshed Cookie leaked through the handle");

  const cloudDetails = await client.getCloudSongDetails([PURE_CLOUD_ID], restored);
  assert(cloudDetails[0]?.title === "纯云盘歌曲", "cloud detail normalization failed");
  const firstPlaylistPage = await client.getUserPlaylists("10000001", restored, 0, 1);
  const secondPlaylistPage = await client.getUserPlaylists("10000001", restored, 1, 1);
  assert(firstPlaylistPage.hasMore && firstPlaylistPage.playlists[0]?.privacy === 1, "private owned playlist was not listed");
  assert(secondPlaylistPage.playlists[0]?.userId === "10000002", "subscribed playlist owner was not preserved");
  const snapshot = await client.getAccountSnapshot(restored, {
    playlistId: "20000001",
    expectedUserId: "10000001",
  });
  assert(snapshot.songs.length === SONGS.size && snapshot.trackIds.length === SONGS.size, "snapshot membership is incomplete");
  const unavailable = snapshot.songs.find((item) => item.id === UNPLAYABLE_ID);
  assert(unavailable?.playable === false && unavailable.playbackReason === "not_found", "unplayable data was not classified");
  assert(snapshot.songs.find((item) => item.id === PURE_CLOUD_ID)?.inCloud === true, "pure-cloud song was not mapped");
  assert(!JSON.stringify(snapshot).includes("media.example.test"), "playback URL escaped the adapter");

  const availability = await client.getPlaybackAvailability([
    200000000,
    200000001,
    200000002,
    200000003,
    200000004,
    200000005,
  ], restored);
  const reasonById = new Map(availability.map((item) => [item.id, item.reason]));
  assert(reasonById.get("200000000") === "playable", "playable response was not classified");
  assert(reasonById.get("200000001") === "no_url", "empty playback URL was not classified");
  assert(reasonById.get("200000002") === "not_found", "missing resource was not classified");
  assert(reasonById.get("200000003") === "account_restricted", "account restriction was not classified");
  assert(reasonById.get("200000004") === "payment_required", "payment requirement was not classified");
  assert(reasonById.get("200000005") === "unknown", "unknown playback failure was not classified");
  await expectNeteaseError(
    () => client.getPlaybackAvailability([OMITTED_PLAYBACK_ID], restored),
    "incomplete_response",
    "an omitted playback result did not fail the complete batch",
  );

  const apiFailureClient = new NeteaseClient({
    fetch: (async () => json({ code: 500 })) as typeof fetch,
    now: () => now,
    retryCount: 0,
  });
  await expectNeteaseError(
    () => apiFailureClient.getPlaybackAvailability([200000000], restored),
    "api",
    "a top-level API failure was treated as a song result",
  );

  const networkFailureClient = new NeteaseClient({
    fetch: (async () => { throw new Error("simulated network failure"); }) as typeof fetch,
    now: () => now,
    retryCount: 0,
  });
  await expectNeteaseError(
    () => networkFailureClient.getPlaybackAvailability([200000000], restored),
    "network",
    "a network failure was treated as a song result",
  );
}

await runNeteaseAdapterSelfTest();
console.log("NetEase adapter self-test passed");
