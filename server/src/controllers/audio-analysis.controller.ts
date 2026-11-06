import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  AssetAudioSummaryResponseDto,
  AssetAudioTranscriptResponseDto,
  AssetAudioWaveformResponseDto,
} from 'src/dtos/audio.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { AudioAnalysisService } from 'src/services/audio-analysis.service.js';
import { AudioSummaryService } from 'src/services/audio-summary.service.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.Assets)
@Controller('assets')
export class AudioAnalysisController {
  constructor(
    private service: AudioAnalysisService,
    private summaryService: AudioSummaryService,
  ) {}

  @Get(':id/audio/waveform')
  @Authenticated({ permission: Permission.AssetView, sharedLink: true })
  @Endpoint({
    summary: 'Retrieve an audio waveform',
    description: 'Retrieve the latest generated waveform and its processing status for an accessible audio asset.',
    history: new HistoryBuilder().added('v3.4.0').beta('v3.4.0'),
  })
  getAssetAudioWaveform(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<AssetAudioWaveformResponseDto> {
    return this.service.getWaveform(auth, id);
  }

  @Get(':id/audio/summary')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Retrieve an audio summary',
    description: 'Retrieve the latest summary and its processing status for an accessible audio asset.',
    history: new HistoryBuilder().added('v3.4.0').beta('v3.4.0'),
  })
  getAssetAudioSummary(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<AssetAudioSummaryResponseDto> {
    return this.summaryService.getSummary(auth, id);
  }

  @Get(':id/audio/transcript')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Retrieve an audio transcript',
    description: 'Retrieve the latest speech transcript and its processing status for an accessible audio asset.',
    history: new HistoryBuilder().added('v3.4.0').beta('v3.4.0'),
  })
  getAssetAudioTranscript(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
  ): Promise<AssetAudioTranscriptResponseDto> {
    return this.service.getTranscript(auth, id);
  }
}
