import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [solid()],
  // Tauri expects a fixed port and its own console output.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // WKWebView (macOS), WebView2 (Windows) and WebKitGTK all support this baseline.
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari15",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    reportCompressedSize: false,
  },
});
