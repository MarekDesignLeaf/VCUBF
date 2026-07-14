import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  define: {
    __VCUBF_BUILD__: JSON.stringify(
      (process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA ?? "local").slice(0, 12),
    ),
  },
  plugins: [react()],
})
