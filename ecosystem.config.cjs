/* eslint-disable @typescript-eslint/no-require-imports */
// eslint-disable-next-line no-undef
const path = require('path')

// eslint-disable-next-line no-undef
module.exports = {
  apps: [
    {
      name: 'kun-touchgal-dlsite-api',
      port: 8686,
      // eslint-disable-next-line no-undef
      cwd: path.join(__dirname),
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      // V8 默认惰性扩堆且不把页还给 OS：实测突发过后 heapUsed 已回落到 71MB，
      // RSS 仍停在 1086MB，足够触发上面这条按 RSS 采样的重启。给老生代一个
      // 低于阈值的上限，逼 V8 在逼近时做全量 GC 而不是一路涨到被 SIGKILL。
      node_args: '--max-old-space-size=640',
      script: './dist/index.js'
    }
  ]
}
