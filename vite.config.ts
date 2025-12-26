import { defineConfig } from 'vite';

export default defineConfig({
  root: './example',
  base: './',
  build: {
    outDir: '../docs',       
    emptyOutDir: true,
  },
});
