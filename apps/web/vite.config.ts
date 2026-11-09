import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "prompt",
      injectRegister: false,
      devOptions: { enabled: false },
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,webmanifest}"],
        globIgnores: ["policy-metadata.js"],
        maximumFileSizeToCacheInBytes: 1_000_000
      },
      manifest: {
        name: "TrinityMatrix",
        short_name: "TrinityMatrix",
        description: "Build melds in multiples of 3, include a natural-card 21, and never exceed 27.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#071b25",
        theme_color: "#071b25",
        orientation: "any",
        icons: [
          { src: "/assets/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/assets/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/assets/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
        ]
      }
    })
  ],
  server: {
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:8181",
      "/healthz": "http://127.0.0.1:8181",
      "/readyz": "http://127.0.0.1:8181",
      "/ws": { target: "ws://127.0.0.1:8181", ws: true }
    }
  },
  test: {
    environment: "happy-dom",
    setupFiles: "./src/test-setup.ts",
    css: true
  }
});
