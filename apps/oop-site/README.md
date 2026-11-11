# OOP promo site

A self-contained static site (plain HTML, CSS and a small amount of JS) that presents OOP, shows how to install it, and links to the public GitHub repository. English and Korean are both in `index.html`; the header toggle switches them (`?lang=ko` also works). **English is the default**: with no `?lang=` and no saved choice the page is English, whatever the browser language is. There is no build step and no dependency.

This is separate from `apps/marketing`, which is the upstream T3 Code site (Astro, deployed to Vercel, serves upstream install scripts).

## Preview locally

Serve this folder with any static server, for example:

```sh
npx serve apps/oop-site -l 4173
```

or `python3 -m http.server 4173 --directory apps/oop-site`, then open <http://localhost:4173>.

## Content sources

Copy and numbers come from the public README, `INSTALL.md` and `docs/screenshots` in `tools/public-export/overlay/`. The screenshots in `assets/shots/` are real captures of the app (and `oop` for the videos) on a fake demo project in the purple `iris` theme, re-encoded as WebP; `tools/public-export/capture/` re-creates them. The logo and favicons are copied from `assets/oop/`. When the install docs or supported platforms change, update `index.html` to match.

`llms.txt` at this folder's root is the same idea for AI tools: an [llmstxt.org](https://llmstxt.org/) index whose links point at the public repository's raw files. `oop-publish` and `oop-publish-site` refuse to publish while a link names a path the export does not carry or a published `docs/user/*.md` page is missing from it (`node --test tools/public-export/site.test.mjs` runs the same check), so when a user guide is added, add its entry (taken from the page's first heading and first sentence) to the `## User guide` list.

## Recordings and motion

The hero and the Terminal section play `assets/video/desktop-demo.mp4` and `assets/video/terminal-demo.mp4` (each with a `.webp` poster of the same name). They are produced separately and are not part of this folder's source; until they exist the poster or a still image is shown. The "Watch the 30-second tour" reel below the hero uses `assets/video/promo-reel.mp4` + `promo-reel.webp` (also produced separately); if it fails to load the whole figure is hidden. The look is a single lavender/violet palette (`:root` tokens in `styles.css`, `theme-color` in `index.html`). Videos play only while on screen and have a play/pause button. The diagrams, sample chart and count-ups are plain HTML, inline SVG and `app.js`; with `prefers-reduced-motion` or without JS they show their final state.

## Deploy to GitHub Pages

The site is served at <https://oop-desktop.github.io/> from the `oop-desktop/oop-desktop.github.io` repository, which holds this folder's files at its root. Each release copies this folder there, and between releases the owner publishes site-only changes with `oop-publish-site` (see `tools/public-export/README.md`). Pages serves the `main` branch as plain files (`.nojekyll`). All asset paths are relative; only the `canonical` and `og:` tags in `index.html` hold the absolute URL.

## Next release preview

The `#next` section in `index.html` and the hero `.next-pill` link preview merged-but-unreleased, user-visible work for one version, named by the `data-next-version` attribute on both. The two attributes must always hold the same version.

To refresh the preview for a new release, change: the version in both `data-next-version` attributes, the version in the section's eyebrow, the h2 and lede, the showcase block (chart gallery, the desktop-vs-terminal panels and the palette strip), and the cards under it.

At release time, move the preview's cards into `#whats-new` (which keeps the last three releases), then either point the preview at the following version, delete the section, the nav link and the pill, or keep the section as that release's showcase without the two attributes and reworded as shipped. The release export refuses to publish while a `data-next-version` is not newer than the version being released. Social carousel images for a preview live in `assets/social/<version>/`.
