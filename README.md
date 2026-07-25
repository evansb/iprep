# Library of Quant

A static site (built with [Astro](https://astro.build)) that hosts a collection of
technical books. Each book is a directory of markdown chapters; the site generates a
home page, a per-book table of contents, and a reading view for every chapter with
sidebar navigation, prev/next paging, syntax highlighting, and a light/dark theme.

## Commands

```sh
npm install      # install dependencies (once)
npm run dev      # local dev server at http://localhost:4321/iprep/
npm run build    # generate the static site into dist/
npm run preview  # preview the production build locally
```

> The site uses a base path of `/iprep` (see `astro.config.mjs`), so locally it is
> served under `/iprep/`, matching the GitHub Pages URL.

## Deployment (GitHub Pages)

The site deploys automatically to **https://evansb.github.io/iprep/** via GitHub Actions
([`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml)).

One-time setup on the `evansb/iprep` repository:

1. Push this project to the repo's `main` branch.
2. In **Settings → Pages → Build and deployment**, set **Source** to **GitHub Actions**.

After that, every push to `main` builds and publishes the site. You can also trigger a
deploy manually from the repo's **Actions** tab.

If the repository is ever renamed, update `site` and `base` in `astro.config.mjs` to match.

## Content model

- Each **book** is a top-level directory of chapter markdown files named `NN-title.md`
  (the leading number sets the order). The first book lives in [`cpp/`](./cpp).
- Chapter titles are read from each file's H1 (`# 1. A Tour of C++`).

### Adding a book

1. Create a new top-level directory (e.g. `python/`) with `NN-title.md` chapter files.
2. Add an entry to [`src/books.ts`](./src/books.ts).

Routes, tables of contents, and navigation are all generated automatically.

## Structure

```
src/
  books.ts            # registry of books (metadata)
  content.config.ts   # Astro content collection (loads chapter markdown)
  lib/chapters.ts     # helpers: ordering, titles, slugs
  layouts/            # BaseLayout (header, theme toggle, footer)
  pages/
    index.astro                     # library home
    books/[book]/index.astro        # book table of contents
    books/[book]/[chapter].astro    # chapter reading view
  styles/global.css   # site styling
```
