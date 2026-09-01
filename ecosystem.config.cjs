/* eslint-disable @typescript-eslint/no-require-imports */
// eslint-disable-next-line no-undef
const path = require('path')

// eslint-disable-next-line no-undef
module.exports = {
  apps: [
    {
      name: 'kun-touchgal-dlsite-api',
      // 不用 pm2 的 port 快捷字段：它会隐式注入 PORT 并强制 cluster 模式，
      // 且它与 shell PORT 的优先级在 fresh start / reload --update-env 两条路径相反。
      // 显式 env 无此问题：实测（pm2 7.0.4）两条路径 shell 的 PORT 都压不过这里，
      // env 块就是端口的单一事实来源。
      // exec_mode 必须显式保留 cluster：startOrReload 不会对已运行进程应用模式切换
      //（实测改成 fork 后 reload 仍是 cluster，需 delete 冷启动），且 cluster 的
      // reload 提供零停机部署。
      exec_mode: 'cluster',
      env: { PORT: '8686' },
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
