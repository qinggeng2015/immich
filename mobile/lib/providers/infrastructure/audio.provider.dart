import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/infrastructure/repositories/audio_folder.repository.dart';
import 'package:immich_mobile/platform/native_audio_api.g.dart';

final audioFolderRepositoryProvider = Provider((ref) => AudioFolderRepository(NativeAudioApi()));
