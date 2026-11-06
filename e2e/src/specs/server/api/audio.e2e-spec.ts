import { AssetMediaStatus, AssetTypeEnum, LoginResponseDto } from '@immich/sdk';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createUserDto } from 'src/fixtures.js';
import { makeRandomImage } from 'src/generators.js';
import { app, asBearerAuth, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

const formats = [
  { extension: 'wav', codec: 'pcm_s16le', format: 'wav' },
  { extension: 'MP3', codec: 'libmp3lame', format: 'mp3' },
  { extension: 'flac', codec: 'flac', format: 'flac' },
  { extension: 'ogg', codec: 'libvorbis', format: 'ogg' },
  { extension: 'opus', codec: 'libopus', format: 'opus' },
  { extension: 'aac', codec: 'aac', format: 'adts' },
  { extension: 'm4a', codec: 'aac', format: 'mp4' },
];

const generateMedia = async (args: string[]) => {
  const { stdout } = await promisify(execFile)(
    'docker',
    ['exec', 'immich-e2e-server', 'ffmpeg', '-hide_banner', '-loglevel', 'error', ...args, 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout;
};

type MediaFixture = { id: string; bytes: Buffer; type: AssetTypeEnum };
type SyncLine = { type: string; ack: string; data: { id?: string; type?: string } };

const clientHeaders = (token: string, audioSupported: boolean): Record<string, string> => {
  const headers: Record<string, string> = asBearerAuth(token);
  if (audioSupported) {
    headers['x-immich-features'] = 'audio';
  }
  return headers;
};

const readSync = (headers: Record<string, string>, reset = false) =>
  request(app)
    .post('/sync/stream')
    .set(headers)
    .send({ types: ['AssetsV2'], reset })
    .buffer(true)
    .parse((response, callback) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        data += chunk;
      });
      response.on('end', () => callback(null, data));
      response.on('error', callback);
    });

describe('audio assets', () => {
  let admin: LoginResponseDto;
  let otherUser: LoginResponseDto;
  const fixtures = new Map<string, MediaFixture>();

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    otherUser = await utils.userSetup(admin.accessToken, createUserDto.create('audio-other'));

    for (const { extension, codec, format } of formats) {
      const bytes = await generateMedia([
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=1',
        '-ac',
        '1',
        '-ar',
        '48000',
        '-c:a',
        codec,
        ...(format === 'mp4' ? ['-movflags', 'frag_keyframe+empty_moov'] : []),
        '-f',
        format,
      ]);
      const asset = await utils.createAsset(admin.accessToken, {
        assetData: { bytes, filename: `tone.${extension}` },
        fileCreatedAt: '2024-05-10T12:00:00.000Z',
        fileModifiedAt: '2024-05-10T12:00:00.000Z',
      });
      expect(asset.status).toBe(AssetMediaStatus.Created);
      fixtures.set(extension, { id: asset.id, bytes, type: AssetTypeEnum.Audio });
    }

    const video = await generateMedia([
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=32x32:r=10:d=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      'frag_keyframe+empty_moov',
      '-f',
      'mp4',
    ]);
    for (const [extension, bytes, type] of [
      ['png', makeRandomImage(), AssetTypeEnum.Image],
      ['mp4', video, AssetTypeEnum.Video],
    ] as const) {
      const asset = await utils.createAsset(admin.accessToken, {
        assetData: { bytes, filename: `regression.${extension}` },
        fileCreatedAt: '2024-05-10T12:00:00.000Z',
        fileModifiedAt: '2024-05-10T12:00:00.000Z',
      });
      expect(asset.status).toBe(AssetMediaStatus.Created);
      fixtures.set(extension, { id: asset.id, bytes, type });
    }

    await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction', 60_000);
    await utils.waitForQueueFinish(admin.accessToken, 'thumbnailGeneration', 60_000);
    await utils.waitForQueueFinish(admin.accessToken, 'videoConversion', 60_000);
  }, 180_000);

  it('should advertise audio capabilities and formats', async () => {
    const features = await request(app).get('/server/features');
    expect(features.status).toBe(200);
    expect(features.body.audio).toBe(true);

    const media = await request(app).get('/server/media-types');
    expect(media.status).toBe(200);
    expect(media.body.audio).toEqual(
      expect.arrayContaining(formats.map(({ extension }) => `.${extension.toLowerCase()}`)),
    );
  });

  it.each(formats)('should process .$extension audio into a playable asset and cover', async ({ extension }) => {
    const { id } = fixtures.get(extension)!;
    const info = await request(app)
      .get(`/assets/${id}`)
      .set(asBearerAuth(admin.accessToken))
      .set('x-immich-features', 'audio');
    expect(info.status).toBe(200);
    expect(info.body.type).toBe(AssetTypeEnum.Audio);
    expect(info.body.duration).toBeGreaterThanOrEqual(900);
    expect(info.body.duration).toBeLessThanOrEqual(1300);

    const thumbnail = await request(app)
      .get(`/assets/${id}/thumbnail?size=thumbnail`)
      .set(asBearerAuth(admin.accessToken));
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.type).toBe('image/webp');
    expect(thumbnail.body.length).toBeGreaterThan(0);

    const playback = await request(app)
      .get(`/assets/${id}/video/playback`)
      .set(asBearerAuth(admin.accessToken))
      .set('Range', 'bytes=0-31');
    expect(playback.status).toBe(206);
    expect(playback.type).toBe('audio/mp4');
    expect(playback.headers['content-range']).toMatch(/^bytes 0-31\/\d+$/);
    expect(Number(playback.headers['content-length'])).toBe(32);
  });

  it('should keep originals byte-for-byte intact and deduplicate reuploads', async () => {
    const { id, bytes } = fixtures.get('wav')!;
    const original = await request(app)
      .get(`/assets/${id}/original`)
      .set(asBearerAuth(admin.accessToken))
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.on('end', () => callback(null, Buffer.concat(chunks)));
        response.on('error', callback);
      });
    expect(original.status).toBe(200);
    expect(original.body).toEqual(bytes);

    const duplicate = await utils.createAsset(admin.accessToken, { assetData: { bytes, filename: 'duplicate.wav' } });
    expect(duplicate).toMatchObject({ id, status: AssetMediaStatus.Duplicate });
  });

  it('should require asset access for playback, ranges, originals and covers', async () => {
    const { id } = fixtures.get('wav')!;
    for (const [path, status] of [
      ['video/playback', 404],
      ['original', 404],
      ['thumbnail?size=thumbnail', 400],
    ] as const) {
      const anonymous = await request(app).get(`/assets/${id}/${path}`).set('Range', 'bytes=0-31');
      expect(anonymous.status).toBe(401);
      const unrelated = await request(app)
        .get(`/assets/${id}/${path}`)
        .set(asBearerAuth(otherUser.accessToken))
        .set('Range', 'bytes=0-31');
      expect(unrelated.status).toBe(status);
    }
  });

  it('should serve a cover for legacy viewers requesting fullsize images', async () => {
    const { id } = fixtures.get('wav')!;
    const fullsize = await request(app)
      .get(`/assets/${id}/thumbnail?size=fullsize`)
      .set(asBearerAuth(admin.accessToken))
      .redirects(2);
    expect(fullsize.status).toBe(200);
    expect(fullsize.type).toBe('image/jpeg');
    expect(fullsize.body.length).toBeGreaterThan(0);
  });

  it('should preserve arbitrary metadata that resembles an audio asset', async () => {
    const { id } = fixtures.get('png')!;
    const value = {
      id: 'custom-metadata',
      type: AssetTypeEnum.Audio,
      originalMimeType: 'audio/wav',
      assets: [{ id: 'nested-metadata', type: AssetTypeEnum.Audio, originalMimeType: 'audio/mp4' }],
    };
    const updated = await request(app)
      .put(`/assets/${id}/metadata`)
      .set(asBearerAuth(admin.accessToken))
      .send({ items: [{ key: 'audio-compatibility', value }] });
    expect(updated.status).toBe(200);
    expect(updated.body).toContainEqual(expect.objectContaining({ key: 'audio-compatibility', value }));

    const fetched = await request(app)
      .get(`/assets/${id}/metadata/audio-compatibility`)
      .set(asBearerAuth(admin.accessToken));
    expect(fetched.status).toBe(200);
    expect(fetched.body.value).toEqual(value);
  });

  it.each([false, true])(
    'should return safe REST and search types with audio capability %s',
    async (audioSupported) => {
      const headers = clientHeaders(admin.accessToken, audioSupported);
      const { id } = fixtures.get('wav')!;
      const info = await request(app).get(`/assets/${id}`).set(headers);
      expect(info.status).toBe(200);
      expect(info.body.type).toBe(audioSupported ? AssetTypeEnum.Audio : AssetTypeEnum.Other);
      expect(info.headers.vary.toLowerCase()).toContain('x-immich-features');

      const search = await request(app).post('/search/metadata').set(headers).send({ size: 100 });
      expect(search.status).toBe(200);
      expect(search.body.assets.items).toHaveLength(fixtures.size);
      for (const fixture of fixtures.values()) {
        expect(search.body.assets.items).toContainEqual(
          expect.objectContaining({
            id: fixture.id,
            type: fixture.type === AssetTypeEnum.Audio && !audioSupported ? AssetTypeEnum.Other : fixture.type,
          }),
        );
      }
    },
  );

  it.each([false, true])('should keep timeline buckets aligned with capability %s', async (audioSupported) => {
    const headers = clientHeaders(admin.accessToken, audioSupported);
    const buckets = await request(app).get('/timeline/buckets').set(headers);
    expect(buckets.status).toBe(200);
    const expected = fixtures
      .values()
      .filter((fixture) => audioSupported || fixture.type !== AssetTypeEnum.Audio)
      .toArray();
    expect(buckets.body.reduce((total: number, bucket: { count: number }) => total + bucket.count, 0)).toBe(
      expected.length,
    );
    const ids: string[] = [];
    for (const { timeBucket, count } of buckets.body) {
      const bucket = await request(app).get('/timeline/bucket').query({ timeBucket }).set(headers);
      expect(bucket.status).toBe(200);
      expect(bucket.body.id).toHaveLength(count);
      expect(bucket.body.isAudio).toHaveLength(count);
      for (const fixture of expected) {
        const index = bucket.body.id.indexOf(fixture.id);
        if (index !== -1) {
          expect(bucket.body.isImage[index]).toBe(fixture.type === AssetTypeEnum.Image);
          expect(bucket.body.isAudio[index]).toBe(fixture.type === AssetTypeEnum.Audio);
        }
      }
      ids.push(...bucket.body.id);
    }
    expect(new Set(ids)).toEqual(new Set(expected.map(({ id }) => id)));
  });

  it.each([false, true])(
    'should preserve sync rows and checkpoints with audio capability %s',
    async (audioSupported) => {
      const headers = clientHeaders(admin.accessToken, audioSupported);
      const response = await readSync(headers, true);
      expect(response.status).toBe(200);
      const lines: SyncLine[] = response.body
        .trim()
        .split('\n')
        .map((line: string) => JSON.parse(line));
      for (const fixture of fixtures.values()) {
        expect(lines).toContainEqual(
          expect.objectContaining({
            type: 'AssetV2',
            data: expect.objectContaining({
              id: fixture.id,
              type: fixture.type === AssetTypeEnum.Audio && !audioSupported ? AssetTypeEnum.Other : fixture.type,
            }),
          }),
        );
      }
      const ack = await request(app)
        .post('/sync/ack')
        .set(headers)
        .send({ acks: lines.map(({ ack }) => ack) });
      expect(ack.status).toBe(204);
      const next = await readSync(headers);
      expect(next.status).toBe(200);
      expect(
        next.body
          .trim()
          .split('\n')
          .map((line: string) => JSON.parse(line)),
      ).toEqual([expect.objectContaining({ type: 'SyncCompleteV1' })]);
    },
  );

  it('should preserve image thumbnails and video playback', async () => {
    const image = fixtures.get('png')!;
    const video = fixtures.get('mp4')!;
    const thumbnail = await request(app)
      .get(`/assets/${image.id}/thumbnail?size=thumbnail`)
      .set(asBearerAuth(admin.accessToken));
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.type).toBe('image/webp');
    const playback = await request(app)
      .get(`/assets/${video.id}/video/playback`)
      .set(asBearerAuth(admin.accessToken))
      .set('Range', 'bytes=0-31');
    expect(playback.status).toBe(206);
    expect(playback.type).toBe('video/mp4');
    const original = await request(app).get(`/assets/${image.id}/original`).set(asBearerAuth(admin.accessToken));
    expect(original.status).toBe(200);
    expect(original.body).toEqual(image.bytes);
  });

  it('should refresh acknowledged audio types when a client upgrades or downgrades', async () => {
    const { id } = fixtures.get('wav')!;
    let reset = true;
    for (const audioSupported of [false, true, false, true]) {
      const headers = clientHeaders(admin.accessToken, audioSupported);
      const response = await readSync(headers, reset);
      expect(response.status).toBe(200);
      const lines: SyncLine[] = response.body
        .trim()
        .split('\n')
        .map((line: string) => JSON.parse(line));
      expect(lines).toContainEqual(
        expect.objectContaining({
          type: 'AssetV2',
          data: expect.objectContaining({ id, type: audioSupported ? AssetTypeEnum.Audio : AssetTypeEnum.Other }),
        }),
      );
      const ack = await request(app)
        .post('/sync/ack')
        .set(headers)
        .send({ acks: lines.map(({ ack }) => ack) });
      expect(ack.status).toBe(204);
      reset = false;
    }
  });
});
