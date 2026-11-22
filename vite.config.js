import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: './',
  plugins: [tailwindcss()],
  // no "npm run dev", as chamadas /api vão para o servidor Node (npm run servidor)
  server: { proxy: { '/api': `http://localhost:${process.env.PORT || 3000}` } },
});
