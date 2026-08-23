import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SPOTIFY_IDLE_REFRESH_MS,
  SPOTIFY_PLAYING_REFRESH_MS,
  SpotifyClient,
  isSpotifyConfigured,
  largestAlbumArt,
  shapeCurrentlyPlaying,
  spotifyModule,
} from '../src/modules/spotify.js';

function response(status, body = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

function playingPayload(isPlaying = true) {
  return {
    is_playing: isPlaying,
    progress_ms: 12_345,
    item: {
      name: 'Night Drive',
      duration_ms: 240_000,
      artists: [{ name: 'A' }, { name: 'B' }],
      album: {
        images: [
          { url: 'small', width: 64, height: 64 },
          { url: 'large', width: 640, height: 640 },
          { url: 'medium', width: 300, height: 300 },
        ],
      },
    },
  };
}

test('Spotify configuration requires client id, secret, and refresh token', () => {
  const base = { spotify: { clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh' } };
  assert.equal(isSpotifyConfigured(base), true);
  assert.equal(isSpotifyConfigured({ spotify: { ...base.spotify, refreshToken: '' } }), false);
  assert.equal(isSpotifyConfigured({ spotify: null }), false);
});

test('album art chooses the largest image without changing the source list', () => {
  const images = [{ url: 'small', width: 10, height: 10 }, { url: 'large', width: 100, height: 100 }];
  assert.equal(largestAlbumArt(images), 'large');
  assert.equal(images[0].url, 'small');
  assert.equal(largestAlbumArt([]), null);
});

test('player shaping preserves paused track metadata and progress', () => {
  assert.deepEqual(shapeCurrentlyPlaying(playingPayload(false)), {
    configured: true,
    isPlaying: false,
    track: { name: 'Night Drive', artists: ['A', 'B'], albumArtUrl: 'large' },
    progressMs: 12_345,
    durationMs: 240_000,
  });
  assert.deepEqual(shapeCurrentlyPlaying(null), {
    configured: true,
    isPlaying: false,
    track: null,
    progressMs: 0,
    durationMs: 0,
  });
});

test('refresh-token flow obtains an access token then calls currently-playing', async () => {
  const calls = [];
  const client = new SpotifyClient({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    refreshToken: 'refresh-token',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/api/token')) return response(200, { access_token: 'access-token', expires_in: 3_600 });
      return response(200, playingPayload());
    },
  });

  const raw = await client.currentlyPlaying();
  assert.equal(raw.item.name, 'Night Drive');
  assert.equal(calls.length, 2);
  assert.match(calls[0].init.headers.authorization, /^Basic /);
  assert.equal(calls[0].init.body.get('grant_type'), 'refresh_token');
  assert.equal(calls[0].init.body.get('refresh_token'), 'refresh-token');
  assert.equal(calls[1].init.headers.authorization, 'Bearer access-token');

  await client.currentlyPlaying();
  assert.equal(calls.length, 3, 'a still-valid access token should be reused');
});

test('204 from the player endpoint means nothing is currently playing', async () => {
  let count = 0;
  const client = new SpotifyClient({
    clientId: 'id',
    clientSecret: 'secret',
    refreshToken: 'refresh',
    fetchImpl: async (url) => {
      count += 1;
      return url.endsWith('/api/token') ? response(200, { access_token: 'token', expires_in: 3_600 }) : response(204);
    },
  });
  assert.equal(await client.currentlyPlaying(), null);
  assert.equal(count, 2);
});

test('an expired player token is refreshed once and the request is retried', async () => {
  let playerCalls = 0;
  let tokenCalls = 0;
  const client = new SpotifyClient({
    clientId: 'id',
    clientSecret: 'secret',
    refreshToken: 'refresh',
    fetchImpl: async (url) => {
      if (url.endsWith('/api/token')) {
        tokenCalls += 1;
        return response(200, { access_token: `token-${tokenCalls}`, expires_in: 3_600 });
      }
      playerCalls += 1;
      return playerCalls === 1 ? response(401, { error: { status: 401 } }) : response(200, playingPayload());
    },
  });
  assert.equal((await client.currentlyPlaying()).item.name, 'Night Drive');
  assert.equal(tokenCalls, 2);
  assert.equal(playerCalls, 2);
});

test('adaptive cadence is five seconds while playing and thirty seconds while idle', () => {
  assert.equal(spotifyModule.refreshMsFor({ data: { isPlaying: true } }), SPOTIFY_PLAYING_REFRESH_MS);
  assert.equal(spotifyModule.refreshMsFor({ data: { isPlaying: false } }), SPOTIFY_IDLE_REFRESH_MS);
  assert.equal(spotifyModule.refreshMsFor({ data: null }), SPOTIFY_IDLE_REFRESH_MS);
});
