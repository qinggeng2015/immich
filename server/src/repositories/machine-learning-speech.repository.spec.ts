import { defaults } from 'src/dtos/config.dto.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { automock } from 'test/utils.js';

const options = { modelName: 'SenseVoiceSmall', language: 'zh' } as const;
const audio = Buffer.from('RIFF-audio-chunk');
const transcript = {
  text: '你好，世界',
  language: 'zh',
  segments: [{ startMs: 0, endMs: 1250, text: '你好，世界' }],
};

describe('MachineLearningRepository speech transcription', () => {
  let sut: MachineLearningRepository;
  const fetchMock = vitest.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vitest.stubGlobal('fetch', fetchMock);
    sut = new MachineLearningRepository(
      automock(LoggingRepository, { args: [undefined, { getEnv: () => ({}) }], strict: false }),
    );
    sut.setup({
      ...defaults.machineLearning,
      urls: ['http://ml-primary:3003', 'http://ml-secondary:3003'],
      availabilityChecks: { ...defaults.machineLearning.availabilityChecks, enabled: false },
    });
  });

  afterEach(() => {
    sut.teardown();
    vitest.unstubAllGlobals();
  });

  it('should send the WAV bytes and speech-only model entry as multipart data', async () => {
    fetchMock.mockResolvedValue(Response.json({ 'speech-to-text': transcript }));

    await expect(sut.transcribe(audio, options)).resolves.toEqual(transcript);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toEqual(new URL('http://ml-primary:3003/predict'));
    expect(request?.method).toBe('POST');
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(request?.signal?.aborted).toBe(false);
    const formData = request?.body as FormData;
    expect(formData.keys().toArray()).toEqual(['entries', 'audio']);
    expect(JSON.parse(formData.get('entries') as string)).toEqual({
      'speech-to-text': { transcription: { modelName: 'SenseVoiceSmall', options: { language: 'zh' } } },
    });
    const file = formData.get('audio') as File;
    expect(file.name).toBe('audio.wav');
    expect(file.type).toBe('audio/wav');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(audio);
  });

  it('should accept silence without manufacturing transcript segments', async () => {
    const silence = { text: '', language: null, segments: [] };
    fetchMock.mockResolvedValue(Response.json({ 'speech-to-text': silence }));

    await expect(sut.transcribe(audio, { ...options, language: 'auto' })).resolves.toEqual(silence);
  });

  it.each([
    { label: 'missing speech result', response: {} },
    { label: 'missing text', response: { 'speech-to-text': { language: 'zh', segments: [] } } },
    { label: 'missing segments', response: { 'speech-to-text': { text: '', language: null } } },
    { label: 'wrong segment shape', response: { 'speech-to-text': { ...transcript, segments: 'invalid' } } },
    { label: 'oversized text', response: { 'speech-to-text': { ...transcript, text: 'a'.repeat(65_537) } } },
    { label: 'oversized language', response: { 'speech-to-text': { ...transcript, language: 'a'.repeat(33) } } },
    {
      label: 'too many segments',
      response: {
        'speech-to-text': { ...transcript, segments: Array.from({ length: 101 }, () => transcript.segments[0]) },
      },
    },
    {
      label: 'oversized segment text',
      response: { 'speech-to-text': { ...transcript, segments: [{ startMs: 0, endMs: 1, text: 'a'.repeat(65_537) }] } },
    },
    ...[-1, 30_001, NaN, Infinity].flatMap((timestamp) =>
      ['startMs', 'endMs'].map((field) => ({
        label: `${field} ${timestamp}`,
        response: {
          'speech-to-text': { ...transcript, segments: [{ ...transcript.segments[0], [field]: timestamp }] },
        },
      })),
    ),
  ])('should reject $label', async ({ response }) => {
    fetchMock.mockResolvedValue(Response.json(response));

    await expect(sut.transcribe(audio, options)).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should try the next server after an HTTP error', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ 'speech-to-text': transcript }));

    await expect(sut.transcribe(audio, options)).resolves.toEqual(transcript);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toEqual(new URL('http://ml-secondary:3003/predict'));
  });

  it('should not send a request when already aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('Transcription canceled');
    controller.abort(reason);

    await expect(sut.transcribe(audio, options, controller.signal)).rejects.toBe(reason);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should propagate cancellation to the request and avoid retrying another server', async () => {
    const controller = new AbortController();
    const reason = new Error('Transcription canceled');
    fetchMock.mockImplementation((_url, request) => {
      expect(request?.signal?.aborted).toBe(false);
      controller.abort(reason);
      expect(request?.signal?.aborted).toBe(true);
      expect(request?.signal?.reason).toBe(reason);
      return Promise.reject(reason);
    });

    await expect(sut.transcribe(audio, options, controller.signal)).rejects.toBe(reason);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
