import { defineConfig } from 'vite';

// Relative base so the build works on any GitHub Pages path (https://<user>.github.io/<repo>/).
export default defineConfig({
  base: './',
  // MapLibre alone is ~1 MB minified.
  build: { chunkSizeWarningLimit: 1500 },
  // Pre-bundling would separate MapLibre from its worker file.
  optimizeDeps: { exclude: ['maplibre-gl'] },
});
