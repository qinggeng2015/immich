import { UnauthorizedException } from '@nestjs/common';
import request from 'supertest';
import { AudioAnalysisController } from 'src/controllers/audio-analysis.controller.js';
import { AudioAnalysisStatus, Permission } from 'src/enum.js';
import { AudioAnalysisService } from 'src/services/audio-analysis.service.js';
import { factory } from 'test/small.factory.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(AudioAnalysisController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(AudioAnalysisService);

  beforeAll(async () => {
    ctx = await controllerSetup(AudioAnalysisController, [{ provide: AudioAnalysisService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    ctx.reset();
    service.resetAllMocks();
  });

  it.each(['waveform', 'transcript'])('should require authentication for %s', async (kind) => {
    ctx.authenticate.mockRejectedValue(new UnauthorizedException());
    const response = await request(ctx.getHttpServer()).get(`/assets/${factory.uuid()}/audio/${kind}`);
    expect(response.status).toBe(401);
  });

  it.each(['waveform', 'transcript'])('should validate asset identifiers for %s', async (kind) => {
    const response = await request(ctx.getHttpServer()).get(`/assets/invalid/audio/${kind}`);
    expect(response.status).toBe(400);
  });

  it('should allow waveform shared-link authorization with asset-view permission', async () => {
    const id = factory.uuid();
    service.getWaveform.mockResolvedValue({ status: AudioAnalysisStatus.Unprocessed, waveform: null });
    const response = await request(ctx.getHttpServer()).get(`/assets/${id}/audio/waveform`);
    expect(response.status).toBe(200);
    expect(ctx.authenticate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ permission: Permission.AssetView, sharedLinkRoute: true }),
      }),
    );
    expect(service.getWaveform).toHaveBeenCalledWith(undefined, id);
  });

  it('should restrict transcript authentication to asset-read without shared links', async () => {
    const id = factory.uuid();
    service.getTranscript.mockResolvedValue({ status: AudioAnalysisStatus.Disabled, transcript: null });
    const response = await request(ctx.getHttpServer()).get(`/assets/${id}/audio/transcript`);
    expect(response.status).toBe(200);
    expect(ctx.authenticate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ permission: Permission.AssetRead, sharedLinkRoute: false }),
      }),
    );
    expect(service.getTranscript).toHaveBeenCalledWith(undefined, id);
  });
});
