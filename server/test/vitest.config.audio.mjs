import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { src: fileURLToPath(new URL('../src', import.meta.url)) } },
  test: {
    name: 'server:audio',
    include: ['test/audio-roundtrip.mjs', 'test/audio-processing.spec.ts'],
    testTimeout: 30_000,
  },
  plugins: [swc.vite()],
});
