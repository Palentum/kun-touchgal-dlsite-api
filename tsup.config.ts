import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  splitting: false,
  sourcemap: false,
  clean: true,
  dts: false,
  shims: false,
  minify: false,
  env: {
    NODE_ENV: process.env.NODE_ENV ?? 'production'
  },
  banner: {
    js: '// Built with tsup'
  }
})
