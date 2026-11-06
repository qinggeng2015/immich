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
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  vitest.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const sut = new MediaRepository(
    automock(LoggingRepository, { args: [undefined, { getEnv: () => ({}) }], strict: false }),
  );
  const finish = async (code = 0) => {
    child.stdout.end();
    child.stderr.end();
    await new Promise<void>((resolve) => setImmediate(resolve));
    child.emit('close', code);
  };
  return { sut, child, finish };
};

describe('audio packet duration', () => {
  beforeEach(() => vitest.clearAllMocks());

  it('should scan the requested stream and handle split lines and a final unterminated packet', async () => {
    const { sut, child, finish } = setup();
    const result = sut.probeAudioDuration('/streamed.flac', 3);
    child.stdout.write('0.000000,0.');
    child.stdout.write('250000\n0.250000,0.250000');
    await finish();

    await expect(result).resolves.toBe(0.5);
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        '3',
        '-show_entries',
        'packet=pts_time,duration_time',
        '-of',
        'csv=p=0',
        '/streamed.flac',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  });

  it('should account for nonzero starting timestamps and packet gaps', async () => {
    const { sut, child, finish } = setup();
    const result = sut.probeAudioDuration('/recording.caf', 0);
    child.stdout.write('5.000000,0.250000\n5.500000,0.250000\n');
    await finish();

    await expect(result).resolves.toBe(0.75);
  });

  it('should sum valid packet durations when timestamps are unavailable', async () => {
    const { sut, child, finish } = setup();
    const result = sut.probeAudioDuration('/recording.flac', 0);
    child.stdout.write('N/A,0.250000\n0.250000,0.250000\ninvalid,N/A\n0,Infinity\n0,-1\n');
    await finish();

    await expect(result).resolves.toBe(0.5);
  });

  it.each(['', 'N/A,N/A\n0,0\n0,-1\n0,Infinity\n'])('should return null without valid packets', async (packets) => {
    const { sut, child, finish } = setup();
    const result = sut.probeAudioDuration('/empty.flac', 0);
    child.stdout.write(packets);
    await finish();

    await expect(result).resolves.toBeNull();
  });

  it('should reject an unsuccessful probe instead of storing partial duration', async () => {
    const { sut, child, finish } = setup();
    const result = sut.probeAudioDuration('/broken.flac', 0);
    const assertion = expect(result).rejects.toThrow('ffprobe exited with code 1: Invalid data');
    child.stdout.write('0,0.25\n');
    child.stderr.write('Invalid data');
    await finish(1);
    await assertion;
  });

  it('should propagate process launch errors', async () => {
    const { sut, child } = setup();
    const result = sut.probeAudioDuration('/recording.flac', 0);
    const assertion = expect(result).rejects.toThrow('ffprobe unavailable');
    child.emit('error', new Error('ffprobe unavailable'));
    child.stdout.end();
    child.stderr.end();
    await assertion;
  });
});
