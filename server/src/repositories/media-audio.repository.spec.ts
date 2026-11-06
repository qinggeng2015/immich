import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { automock } from 'test/utils.js';

vitest.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vitest.fn(),
}));

const setup = () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vitest.fn(),
  });
  child.kill.mockImplementation((signal: NodeJS.Signals) => {
    child.signalCode = signal;
    child.stdout.destroy();
    child.stderr.end();
    child.emit('close', null);
    return true;
  });
  vitest.mocked(spawn).mockImplementation((command) => {
    if (command === 'ffprobe') {
      const probe = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null as number | null,
        signalCode: null,
        kill: vitest.fn(),
      });
      queueMicrotask(() => {
        probe.stdout.end('1\n');
        probe.stderr.end();
        probe.exitCode = 0;
        probe.emit('close', 0);
      });
      return probe as unknown as ReturnType<typeof spawn>;
    }
    return child as unknown as ReturnType<typeof spawn>;
  });
  const sut = new MediaRepository(
    automock(LoggingRepository, { args: [undefined, { getEnv: () => ({}) }], strict: false }),
  );
  const finish = (code = 0) => {
    child.exitCode = code;
    child.stdout.end();
    child.stderr.end();
    child.emit('close', code);
  };
  return { sut, child, finish };
};

describe('streamed audio processing', () => {
  beforeEach(() => vitest.clearAllMocks());

  it('should decode the selected audio stream and compute waveform duration from actual samples', async () => {
    const { sut, child, finish } = setup();
    const waveform = sut.generateAudioWaveform('/recording.flac', 3);
    await new Promise<void>((resolve) => setImmediate(resolve));
    child.stdout.write(Buffer.alloc(96_000));
    finish();

    await expect(waveform).resolves.toMatchObject({ version: 1, durationMs: 1000 });
    expect(spawn).toHaveBeenCalledWith(
      'ffmpeg',
      expect.arrayContaining(['-nostdin', '-map', '0:3', '-vn', '-ar', '48000', '-f', 's16le']),
      expect.anything(),
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('should emit at most thirty seconds of WAV per chunk with contiguous offsets and a final partial chunk', async () => {
    const { sut, child, finish } = setup();
    const chunks = sut.streamAudioChunks('/speech.m4a', 0);
    const first = chunks.next();
    child.stdout.write(Buffer.alloc(960_003, 1));
    const { value } = await first;
    expect(value).toMatchObject({ startMs: 0, durationMs: 30_000 });
    expect(value!.data.length).toBe(960_044);
    expect(value!.data.subarray(0, 4).toString()).toBe('RIFF');
    expect(value!.data.readUInt32LE(24)).toBe(16_000);
    expect(value!.data.readUInt32LE(40)).toBe(960_000);
    child.stdout.write(Buffer.alloc(31_997, 2));
    finish();

    const last = await chunks.next();
    expect(last.value).toMatchObject({ startMs: 30_000, durationMs: 1000 });
    expect(last.value!.data.length).toBe(32_044);
    expect(last.value!.data.subarray(44, 47)).toEqual(Buffer.alloc(3, 1));
    const completed = await chunks.next();
    expect(completed.done).toBe(true);
  });

  it('should terminate the decoder when a speech consumer stops after a chunk', async () => {
    const { sut, child } = setup();
    const chunks = sut.streamAudioChunks('/long.flac', 0);
    const first = chunks.next();
    child.stdout.write(Buffer.alloc(960_000));
    await first;
    await chunks.return(undefined);

    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    expect(child.stdout.destroyed).toBe(true);
  });

  it('should apply backpressure while the consumer is processing a speech chunk', async () => {
    const { sut, child } = setup();
    const chunks = sut.streamAudioChunks('/long.flac', 0);
    const first = chunks.next();
    child.stdout.write(Buffer.alloc(960_000));
    await first;
    const written = vitest.fn();
    child.stdout.write(Buffer.alloc(960_000), written);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(written).not.toHaveBeenCalled();

    await chunks.next();
    expect(written).toHaveBeenCalledOnce();
    await chunks.return(undefined);
  });

  it('should propagate a late decoder failure after earlier speech chunks were consumed', async () => {
    const { sut, child, finish } = setup();
    const chunks = sut.streamAudioChunks('/truncated.flac', 0);
    const first = chunks.next();
    child.stdout.write(Buffer.alloc(960_000));
    await first;
    child.stderr.write('Truncated audio');
    finish(1);

    await expect(chunks.next()).rejects.toThrow('Truncated audio');
  });

  it('should terminate the decoder when a speech consumer throws', async () => {
    const { sut, child } = setup();
    const consume = async () => {
      for await (const chunk of sut.streamAudioChunks('/long.flac', 0)) {
        expect(chunk.durationMs).toBe(30_000);
        throw new Error('ML request failed');
      }
    };
    const consumed = consume();
    child.stdout.write(Buffer.alloc(960_000));

    await expect(consumed).rejects.toThrow('ML request failed');
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  });

  it('should reject decoder failures instead of publishing partial waveform data', async () => {
    const { sut, child, finish } = setup();
    const waveform = sut.generateAudioWaveform('/broken.flac', 0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    child.stdout.write(Buffer.alloc(96_000));
    child.stderr.write('Invalid audio');
    finish(1);

    await expect(waveform).rejects.toThrow('Audio decoder exited with code 1: Invalid audio');
  });

  it('should propagate decoder launch errors and aborts', async () => {
    const { sut, child } = setup();
    const controller = new AbortController();
    const waveform = sut.generateAudioWaveform('/recording.flac', 0, controller.signal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    child.emit('error', new Error('The operation was aborted'));

    await expect(waveform).rejects.toThrow('The operation was aborted');
    expect(spawn).toHaveBeenCalledWith(
      'ffmpeg',
      expect.anything(),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('should bound decoder diagnostics', async () => {
    const { sut, child, finish } = setup();
    const chunks = sut.streamAudioChunks('/broken.flac', 0);
    const next = chunks.next();
    child.stderr.write(`discarded prefix${'x'.repeat(100_000)}final error`);
    finish(1);

    const error = await next.catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message.length).toBeLessThan(16_450);
    expect((error as Error).message).not.toContain('discarded prefix');
    expect((error as Error).message).toContain('final error');
  });

  it.each([Buffer.alloc(0), Buffer.from([1])])('should reject empty or incomplete speech PCM', async (pcm) => {
    const { sut, child, finish } = setup();
    const chunks = sut.streamAudioChunks('/empty.flac', 0);
    const next = chunks.next();
    child.stdout.write(pcm);
    finish();

    await expect(next).rejects.toThrow(/no decoded samples|Incomplete audio PCM sample/);
  });
});
