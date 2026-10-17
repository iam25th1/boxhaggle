import { defineConfig } from "vite";

// The in-chat counter (MCP App resource ui://boxhaggle/counter). Built to
// dist-counter, then scripts/inline-counter.mjs folds the script and styles
// into one self-contained counter.html that the merchant serves.
export default defineConfig({
  root: ".",
  base: "./",
  envPrefix: "VITE_COUNTER_",
  resolve: {
    // ext-apps and the MCP client must share one protocol core.
    dedupe: ["@modelcontextprotocol/core"],
  },
  build: {
    outDir: "dist-counter",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    cssCodeSplit: false,
    modulePreload: false,
    // Fonts and any other asset become data URIs: the iframe loads nothing remote.
    assetsInlineLimit: 1_000_000,
    rollupOptions: {
      input: "counter.html",
      output: { codeSplitting: false },
    },
  },
});
