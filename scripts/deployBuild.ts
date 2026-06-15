import { execSync } from 'child_process'

try {
  console.log('Executing the commands...')

  execSync('git pull && pnpm build && pnpm start', {
    stdio: 'inherit'
  })
} catch (error) {
  console.error('Deploy build failed', error)
  process.exit(1)
}
