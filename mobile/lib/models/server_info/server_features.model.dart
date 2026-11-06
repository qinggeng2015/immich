import 'package:flutter/foundation.dart';
import 'package:freezed_annotation/freezed_annotation.dart';
import 'package:openapi/api.dart';

part 'server_features.model.freezed.dart';

@freezed
abstract class ServerFeatures with _$ServerFeatures {
  const factory ServerFeatures({
    required bool trash,
    required bool map,
    required bool oauthEnabled,
    required bool passwordLogin,
    @Default(false) bool ocr,
    @Default(false) bool smartSearch,
    @Default(false) bool audio,
    @Default(false) bool audioWaveform,
    @Default(false) bool speechToText,
    @Default(false) bool audioSummary,
  }) = _ServerFeatures;

  factory ServerFeatures.fromDto(ServerFeaturesDto dto) => ServerFeatures(
    trash: dto.trash,
    map: dto.map,
    oauthEnabled: dto.oauth,
    passwordLogin: dto.passwordLogin,
    ocr: dto.ocr,
    smartSearch: dto.smartSearch,
    audio: dto.audio.orElse(null) ?? false,
    audioWaveform: dto.audioWaveform.orElse(null) ?? false,
    speechToText: dto.speechToText.orElse(null) ?? false,
    audioSummary: dto.audioSummary.orElse(null) ?? false,
  );
}
