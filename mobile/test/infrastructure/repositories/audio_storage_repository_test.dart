import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/infrastructure/repositories/storage.repository.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('com.fluttercandies/photo_manager');
  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  final calls = <String>[];
  final repository = StorageRepository();
  final supportedHost = Platform.isAndroid || Platform.isIOS || Platform.isMacOS;
  final properties = <String, Object>{
    'id': '42',
    'type': 3,
    'width': 0,
    'height': 0,
    'duration': 65,
    'title': 'recording.flac',
  };

  setUp(calls.clear);
  tearDown(() => messenger.setMockMethodCallHandler(channel, null));

  test('audio source uses only entity lookup and original file access', () async {
    final directory = await Directory.systemTemp.createTemp('immich-audio-storage-');
    addTearDown(() => directory.delete(recursive: true));
    final original = await File('${directory.path}/recording.flac').writeAsBytes([102, 76, 97, 67, 1, 2, 3]);
    messenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call.method);
      expect(call.arguments['id'], '42');
      return switch (call.method) {
        'fetchEntityProperties' => properties,
        'getFullFile' => original.path,
        _ => throw StateError('Unexpected request: ${call.method}'),
      };
    });

    final file = await repository.getFileForAsset('42');

    expect(file?.path, original.path);
    expect(await file!.readAsBytes(), [102, 76, 97, 67, 1, 2, 3]);
    expect(calls, ['fetchEntityProperties', 'getFullFile']);
  }, skip: !supportedHost);

  test('revoked audio access returns no file without requesting photo permissions', () async {
    messenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call.method);
      if (call.method == 'fetchEntityProperties') {
        return properties;
      }
      throw PlatformException(code: 'PERMISSION_DENIED');
    });

    expect(await repository.getFileForAsset('42'), isNull);
    expect(calls, ['fetchEntityProperties', 'getFullFile']);
  }, skip: !supportedHost);

  test('removed audio returns no file and does not attempt export', () async {
    messenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call.method);
      return null;
    });

    expect(await repository.getFileForAsset('42'), isNull);
    expect(calls, ['fetchEntityProperties']);
  });
}
