import { defineConfig, fontProviders } from 'astro/config';
import { remarkMermaid } from './src/lib/remark-mermaid.mjs';


// https://astro.build
export default defineConfig({
  // Deployed to GitHub Pages at https://evansb.github.io/iprep/
  site: 'https://evansb.github.io',
  base: '/iprep',
  experimental: {
    // Body reading font, self-hosted at build time — no request to a font CDN.
    fonts: [
      {
        provider: fontProviders.fontsource(),
        name: 'Source Serif 4',
        cssVariable: '--font-source-serif',
        weights: [400, 600, 700],
        styles: ['normal', 'italic'],
      },
    ],
  },
  markdown: {
    // Runs before Shiki so ```mermaid fences become renderable blocks
    // rather than syntax-highlighted code.
    remarkPlugins: [remarkMermaid],
    shikiConfig: {
      // Dual themes: light renders inline, dark is switched via CSS (see global.css).
      themes: {
        light: 'github-light',
        dark: 'github-dark',
      },
    },
  },
});
