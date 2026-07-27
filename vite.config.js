import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Vite does not read PORT on its own — without this it always tries 5173
    // and collides with anything already there. Honouring PORT lets the dev
    // harness assign a free port instead.
    port: Number(process.env.PORT) || 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:5050',
        changeOrigin: true
      }
    }
  }
})
