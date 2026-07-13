import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      manifest: {
        name: "VCUBF Secretary",
        short_name: "VCUBF",
        description: "VCUBF Secretary business workspace with Emma voice assistance.",
        theme_color: "#234f38",
        background_color: "#f5f6f8",
        display: "standalone",
        orientation: "any",
        start_url: "/",
        scope: "/",
        categories: ["business", "productivity"],
        icons: [
          { src: "/vcubf-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/backend-production-7952\.up\.railway\.app\/health$/,
            handler: "NetworkFirst",
            options: { cacheName: "vcubf-health", expiration: { maxEntries: 1, maxAgeSeconds: 60 } },
          },
        ],
      },
    }),
  ],
})
