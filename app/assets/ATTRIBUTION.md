# Artwork credits

## Emoji
Eight unmodified Twemoji graphics, by Twitter, Inc. and other contributors to Twemoji. Source: https://github.com/jdecked/twemoji/tree/v17.0.3/assets/svg

Licensed under Creative Commons Attribution 4.0 International (CC BY 4.0): https://creativecommons.org/licenses/by/4.0/

The full license is included in `emoji/LICENSE-GRAPHICS`. SVGs were rendered as PNGs for native app compatibility; no artwork edits were made. Unicode emoji characters inserted into text use the device's normal emoji font. The emoji picker uses the bundled Twemoji artwork.

## Little moods stickers
Original cat artwork authored for the Common Figma concept. SVG source preserved in `stickers/`. Distributed as part of Common under GPL-3.0-only. It uses no third-party sticker artwork.

Both packs are bundled with the application and work without requesting images from third-party servers.

## LinkUp identity

The interlocking-conversations mark is a manually rebuilt vector of the selected logo concept generated with ImageGen for this project. The logo SVGs contain only paths, with no embedded bitmap or external font dependency. The LinkUp wordmark is outlined from Manrope Bold, distributed under the SIL Open Font License; see `../legal/manrope-font-OFL.txt`. The mark and application artwork are distributed with LinkUp under GPL-3.0-only.

Edit the vector masters in `brand/`, then run `scripts/generate-brand-assets.mjs` with the `sharp` build tool available (or its package directory in `NODE_PATH`) to regenerate app icons, previews and `src/brand/artwork.ts`.
