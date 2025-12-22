import { defineConfig } from 'vite';

export default defineConfig({
  root: './example',
  base: './',
  build: {
    outDir: '../docs',           // 构建产物放到仓库根的 docs/ 目录
    emptyOutDir: true,
  },
});
