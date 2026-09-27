import { defineConfig, loadEnv } from 'vite'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { chatGatewayPlugin } from './server/chatGateway.ts'

// https://vite.dev/config/
// The gateway owns the project-process lock and the browser editor lease for the full server lifecycle.
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), tailwindcss(), chatGatewayPlugin(env, {
      singleInstance: command === 'serve' && env.BRACE_MAP_ALLOW_MULTIPLE_INSTANCES !== '1',
    })],
    build: {
      rolldownOptions: {
        input: {
          main: resolve(process.cwd(), 'index.html'),
          contextDemo: resolve(process.cwd(), 'context-demo.html'),
        },
      },
    },
  }
})
