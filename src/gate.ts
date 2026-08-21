// 在途抓取的上限。ecosystem.config.cjs 是 instances: 1 + max_memory_restart: '1G'，
// 而 pm2 采样的是 RSS。用真实 fixture 实测峰值 RSS：16 路 239MB、32 路 365MB、
// 64 路 587MB，无上限时 150 路在 247MB 与 1331MB 之间剧烈波动（取决于 V8 是否
// 在突发中途触发 major GC），越线即 SIGKILL 并丢弃全部在途请求。
// 取 32 而非更保守的 16：合法的批量查询不该被削掉，365MB 距阈值仍有 2.8 倍余量。
export const MAX_IN_FLIGHT = 32

let inFlight = 0

// 满了就返回 null，由调用方立刻 503：排队不设等待期限只是把内存问题换成尾延迟
// 问题（单次抓取的预算是 TOTAL_TIMEOUT_MS = 30s）。503 对调用方也是安全的，
// 它会重试；换成 404 会被当成「作品不存在」这个事实持久化下来。
export const tryAcquire = (): (() => void) | null => {
  if (inFlight >= MAX_IN_FLIGHT) return null

  inFlight += 1
  return () => {
    inFlight -= 1
  }
}
