import { defineConfig } from 'astro/config';

// https://astro.build
export default defineConfig({
  // Deployed to GitHub Pages at https://evansb.github.io/iprep/
  site: 'https://evansb.github.io',
  base: '/iprep',
  markdown: {
    shikiConfig: {
      // Dual themes: light renders inline, dark is switched via CSS (see global.css).
      themes: {
        light: 'github-light',
        dark: 'github-dark',
      },
    },
  },
});
