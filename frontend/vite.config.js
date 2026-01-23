import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'path';

export default defineConfig({
  plugins: [svelte({
    compilerOptions: {
      css: 'injected' 
    }
  })],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/main.ts'),
      name: 'momo',
      fileName: (format) => `momo-comment.min.js`,
      formats: ['iife']
    },
    rollupOptions: {
    }
  }
});