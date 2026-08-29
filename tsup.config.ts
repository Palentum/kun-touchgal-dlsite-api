import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  splitting: false,
  sourcemap: false,
  // clean 必须为 false：构建失败时保留上一版 dist/index.js 作回滚件，
  // clean: true 会在编译前清空 dist，中途失败即丢失可启动产物
  clean: false,
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
