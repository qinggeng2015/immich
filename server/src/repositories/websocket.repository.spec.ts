import { Socket } from 'socket.io';
import { AssetResponseDto } from 'src/dtos/asset-response.dto.js';
import { NotificationDto } from 'src/dtos/notification.dto.js';
import { AssetType, NotificationLevel, NotificationType } from 'src/enum.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { getMocks } from 'test/utils.js';

const setup = () => {
  const mocks = getMocks();
  const sut = new WebsocketRepository(
    mocks.event as unknown as EventRepository,
    mocks.logger as unknown as LoggingRepository,
  );
  const server = { to: vitest.fn().mockReturnThis(), emit: vitest.fn() };
  Object.defineProperty(sut, 'server', { value: server });
  return { sut, server, mocks };
};

describe(WebsocketRepository.name, () => {
  it.each(['header', 'auth', 'neither'])('should negotiate capability using %s', async (source) => {
    const { sut, mocks } = setup();
    const auth = AuthFactory.from().session().build();
    sut.setAuthFn(() => Promise.resolve(auth));
    mocks.event.emit.mockResolvedValue(void 0);
    const client = {
      id: 'socket',
      request: { headers: source === 'header' ? { 'x-immich-features': 'audio' } : {} },
      handshake: { auth: source === 'auth' ? { features: 'audio' } : {} },
      join: vitest.fn().mockResolvedValue(undefined),
      emit: vitest.fn(),
      disconnect: vitest.fn(),
    };

    await sut.handleConnection(client as unknown as Socket);

    expect(client.join).toHaveBeenCalledWith(auth.user.id);
    expect(client.join).toHaveBeenCalledWith(auth.session!.id);
    expect(client.disconnect).not.toHaveBeenCalled();
    if (source === 'neither') {
      expect(client.join).toHaveBeenCalledTimes(2);
    } else {
      expect(client.join).toHaveBeenCalledWith('feature:audio:all');
      expect(client.join).toHaveBeenCalledWith(`feature:audio:${auth.user.id}`);
      expect(client.join).toHaveBeenCalledWith(`feature:audio:${auth.session!.id}`);
    }
  });

  it.each([AssetType.Audio, AssetType.Image, AssetType.Video])(
    'should route %s events to compatible clients',
    (type) => {
      const { sut, server } = setup();
      const asset = { id: 'asset', type, originalMimeType: 'audio/wav' } as AssetResponseDto;

      sut.clientSend('on_upload_success', 'user', asset);

      expect(server.to).toHaveBeenCalledWith(type === AssetType.Audio ? 'feature:audio:user' : 'user');
      expect(server.emit).toHaveBeenCalledWith('on_upload_success', asset);
    },
  );

  it('should restrict audio broadcasts while retaining ordinary broadcasts', () => {
    const { sut, server } = setup();
    const asset = { id: 'asset', type: AssetType.Audio, originalMimeType: 'audio/wav' } as AssetResponseDto;
    sut.clientBroadcast('on_asset_update', asset);
    expect(server.to).toHaveBeenCalledWith('feature:audio:all');
    expect(server.emit).toHaveBeenCalledWith('on_asset_update', asset);

    server.to.mockClear();
    sut.clientBroadcast('on_config_update');
    expect(server.to).not.toHaveBeenCalled();
    expect(server.emit).toHaveBeenCalledWith('on_config_update');
  });

  it('should deliver notifications with arbitrary audio-shaped data to all clients', () => {
    const { sut, server } = setup();
    const notification: NotificationDto = {
      id: 'notification',
      createdAt: new Date(),
      level: NotificationLevel.Info,
      type: NotificationType.Custom,
      title: 'Custom notification',
      data: { id: 'user-metadata', type: AssetType.Audio, originalMimeType: 'audio/wav' },
    };

    sut.clientSend('on_notification', 'user', notification);
    expect(server.to).toHaveBeenCalledWith('user');
    expect(server.emit).toHaveBeenCalledWith('on_notification', notification);

    server.to.mockClear();
    sut.clientBroadcast('on_notification', notification);
    expect(server.to).not.toHaveBeenCalled();
    expect(server.emit).toHaveBeenCalledWith('on_notification', notification);
  });
});
