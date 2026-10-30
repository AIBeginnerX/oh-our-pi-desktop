# OOP promo site

A self-contained static site (plain HTML, CSS and a small amount of JS) that presents OOP, shows how to install it, and links to the public GitHub repository. English and Korean are both in `index.html`; the header toggle switches them (`?lang=ko` also works). There is no build step and no dependency.

This is separate from `apps/marketing`, which is the upstream T3 Code site (Astro, deployed to Vercel, serves upstream install scripts).

## Preview locally

Serve this folder with any static server, for example:

```sh
npx serve apps/oop-site -l 4173
```

or `python3 -m http.server 4173 --directory apps/oop-site`, then open <http://localhost:4173>.

## Content sources

Copy and numbers come from the public README, `INSTALL.md` and `docs/screenshots` in `tools/public-export/overlay/`. Screenshots in `assets/shots/` are those PNGs re-encoded as WebP; the logo and favicons are copied from `assets/oop/`. When the install docs or supported platforms change, update `index.html` to match.

## Deploy to GitHub Pages

The site is served at <https://oop-desktop.github.io/> from the `oop-desktop/oop-desktop.github.io` repository, which holds this folder's files at its root. Each release copies this folder there, and Pages serves the `main` branch as plain files (`.nojekyll`). All asset paths are relative; only the `canonical` and `og:` tags in `index.html` hold the absolute URL.
