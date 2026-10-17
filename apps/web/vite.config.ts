import { defineConfig } from "vite";

// The spectator UI is a static bundle. The only runtime setting is
// VITE_MERCHANT_URL, read at build time for Live mode.
export default defineConfig({
  root: ".",
  base: "./",
  envPrefix: "VITE_",
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
  },
});
