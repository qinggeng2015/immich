import { Kysely } from 'kysely';
import { AlbumUserRole, AssetType, SyncEntityType, SyncRequestType } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DB } from 'src/schema/index.js';
import { fromAck } from 'src/utils/sync.js';
import { SyncTestContext } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let database: Kysely<DB>;

const assetGroups = [SyncRequestType.AssetsV2, SyncRequestType.PartnerAssetsV2, SyncRequestType.AlbumAssetsV2];
const relationshipGroups = [SyncRequestType.PartnersV1, SyncRequestType.AlbumsV2, SyncRequestType.AlbumToAssetsV1];
const assetEntities = new Set([
  SyncEntityType.AssetV2,
  SyncEntityType.PartnerAssetV2,
  SyncEntityType.PartnerAssetBackfillV2,
  SyncEntityType.AlbumAssetCreateV2,
  SyncEntityType.AlbumAssetUpdateV2,
  SyncEntityType.AlbumAssetBackfillV2,
]);

const setup = async () => {
  const ctx = new SyncTestContext(database);
  const { auth } = await ctx.newSyncAuthUser();
  const { asset } = await ctx.newAsset({ ownerId: auth.user.id, type: AssetType.Audio });
  const { asset: image } = await ctx.newAsset({ ownerId: auth.user.id, type: AssetType.Image });
  const { asset: video } = await ctx.newAsset({ ownerId: auth.user.id, type: AssetType.Video });
  const { user: partner } = await ctx.newUser();
  const { asset: partnerAsset } = await ctx.newAsset({ ownerId: partner.id, type: AssetType.Audio });
  await ctx.newPartner({ sharedById: partner.id, sharedWithId: auth.user.id });
  const { user: albumOwner } = await ctx.newUser();
  const { asset: albumAsset } = await ctx.newAsset({ ownerId: albumOwner.id, type: AssetType.Audio });
  const { album } = await ctx.newAlbum({ ownerId: albumOwner.id });
  await ctx.newAlbumAsset({ albumId: album.id, assetId: albumAsset.id });
  await ctx.newAlbumUser({ albumId: album.id, userId: auth.user.id, role: AlbumUserRole.Editor });

  return { ctx, auth, asset, image, video, partnerAsset, albumAsset };
};

const getAssetTypes = (response: Awaited<ReturnType<SyncTestContext['syncStream']>>) =>
  response
    .filter((item) => assetEntities.has(item.type as SyncEntityType))
    .map(({ data }) => ({ id: data.id, type: data.type }));

const getCompletion = (response: Awaited<ReturnType<SyncTestContext['syncStream']>>) =>
  fromAck(response.find(({ type }) => type === SyncEntityType.SyncCompleteV1)!.ack);

beforeAll(async () => {
  database = await getKyselyDB();
});

describe('audio sync compatibility', () => {
  it('should replay each asset group on repeated capability changes without resetting relationship or delete progress', async () => {
    const { ctx, auth, asset, image, video, partnerAsset, albumAsset } = await setup();
    const { asset: deleted } = await ctx.newAsset({ ownerId: auth.user.id });
    await ctx.get(AssetRepository).remove(deleted);
    const initial = await ctx.syncStream(auth, [...assetGroups, ...relationshipGroups]);
    expect(getCompletion(initial).extraId).toBeUndefined();
    expect(initial).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: SyncEntityType.PartnerV1 }),
        expect.objectContaining({ type: SyncEntityType.AlbumV2 }),
        expect.objectContaining({ type: SyncEntityType.AlbumToAssetV1 }),
        expect.objectContaining({ type: SyncEntityType.AssetDeleteV1 }),
      ]),
    );
    expect(getAssetTypes(initial)).toEqual([
      { id: asset.id, type: AssetType.Other },
      { id: image.id, type: AssetType.Image },
      { id: video.id, type: AssetType.Video },
      { id: partnerAsset.id, type: AssetType.Other },
      { id: albumAsset.id, type: AssetType.Other },
    ]);
    await ctx.syncAckAll(auth, initial);
    const initialAcks = await ctx.sut.getAcks(auth);
    const unchangedAcks = initialAcks.filter(({ type }) =>
      [
        SyncEntityType.PartnerV1,
        SyncEntityType.AlbumV2,
        SyncEntityType.AlbumToAssetV1,
        SyncEntityType.AssetDeleteV1,
      ].includes(type),
    );

    for (const audioSupported of [true, false, true, false]) {
      const clientAuth = { ...auth, audioSupported };
      const metadata = await ctx.syncStream(clientAuth, [SyncRequestType.AssetMetadataV1]);
      expect(getAssetTypes(metadata)).toEqual([]);
      expect(getCompletion(metadata).extraId).toBe(
        audioSupported ? undefined : 'audio:AssetsV2,PartnerAssetsV2,AlbumAssetsV2',
      );
      await ctx.syncAckAll(clientAuth, metadata);

      for (const [index, group] of assetGroups.entries()) {
        const response = await ctx.syncStream(clientAuth, [group]);
        const type = audioSupported ? AssetType.Audio : AssetType.Other;
        expect(getAssetTypes(response)).toEqual(
          index === 0
            ? [
                { id: asset.id, type },
                { id: image.id, type: AssetType.Image },
                { id: video.id, type: AssetType.Video },
              ]
            : [{ id: index === 1 ? partnerAsset.id : albumAsset.id, type }],
        );
        expect(response.some(({ type }) => type === SyncEntityType.AssetDeleteV1)).toBe(false);
        const expectedAudioGroups = audioSupported ? assetGroups.slice(0, index + 1) : assetGroups.slice(index + 1);
        expect(getCompletion(response).extraId).toBe(
          expectedAudioGroups.length > 0 ? `audio:${expectedAudioGroups.join(',')}` : undefined,
        );
        await ctx.syncAckAll(clientAuth, response);
        await ctx.assertSyncIsComplete(clientAuth, [group]);
      }

      await ctx.assertSyncIsComplete(clientAuth, [...assetGroups, ...relationshipGroups]);
      expect(await ctx.sut.getAcks(clientAuth)).toEqual(expect.arrayContaining(unchangedAcks));
    }
  });

  it.each([false, true])(
    'should recover all groups after partially acknowledged transitions from capability %s',
    async (audioSupported) => {
      const { ctx, auth, asset, partnerAsset, albumAsset } = await setup();
      const originalAuth = { ...auth, audioSupported };
      const initial = await ctx.syncStream(originalAuth, assetGroups);
      await ctx.syncAckAll(originalAuth, initial);
      const initialCompletion = getCompletion(initial);

      const changedAuth = { ...auth, audioSupported: !audioSupported };
      const interrupted = await ctx.syncStream(changedAuth, assetGroups);
      await ctx.syncAckAll(
        changedAuth,
        interrupted.filter(({ type }) => type !== SyncEntityType.SyncCompleteV1),
      );
      const checkpoints = await ctx.sut.getAcks(auth);
      const pendingCheckpoint = checkpoints.find(({ type }) => type === SyncEntityType.SyncCompleteV1)!;
      expect(fromAck(pendingCheckpoint.ack).updateId).toBe(initialCompletion.updateId);
      expect(fromAck(pendingCheckpoint.ack).extraId).toContain('pending:AssetsV2,PartnerAssetsV2,AlbumAssetsV2');

      const metadata = await ctx.syncStream(originalAuth, [SyncRequestType.AssetMetadataV1]);
      expect(getCompletion(metadata).extraId).toContain('pending:AssetsV2,PartnerAssetsV2,AlbumAssetsV2');
      await ctx.syncAckAll(originalAuth, metadata);

      for (const [index, group] of assetGroups.entries()) {
        const response = await ctx.syncStream(originalAuth, [group]);
        expect(getAssetTypes(response)).toContainEqual({
          id: [asset, partnerAsset, albumAsset][index].id,
          type: audioSupported ? AssetType.Audio : AssetType.Other,
        });
        const pendingGroups = assetGroups.slice(index + 1);
        if (pendingGroups.length > 0) {
          expect(getCompletion(response).extraId).toContain(`pending:${pendingGroups.join(',')}`);
        } else {
          expect(getCompletion(response).extraId ?? '').not.toContain('pending:');
        }
        await ctx.syncAckAll(originalAuth, response);
        await ctx.assertSyncIsComplete(originalAuth, [group]);
      }
      await ctx.assertSyncIsComplete(originalAuth, assetGroups);
    },
  );
});
