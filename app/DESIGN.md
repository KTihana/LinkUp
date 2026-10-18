# LinkUp design

LinkUp is a private messenger for conversations with people you know. Blue is its brand color: a clear #335CFF accent, white and pale blue surfaces, and navy in dark mode. Native system typography, generous spacing and clear controls give people and messages priority.

## Layout and interaction

- Phones show one primary task at a time, with a floating tab bar and focused conversation screens.
- Desktop web uses an adaptive navigation rail, conversation list and reading pane. Short windows keep actions reachable through scrolling.
- System type, consistent alignment and a restrained hierarchy keep names, messages and supporting information readable.
- Shared controls provide brief spring and pressed feedback. Reduced-motion preferences remove movement while keeping visual feedback. Browser controls have visible keyboard focus.
- Search matches conversation names and text history. Preview conversations are clearly marked as samples. The welcome text is “Private conversations with friends.” Supporting copy is functional and concise. The unread filter is shown only in the sample preview until persistent read tracking is available for real accounts.
- Appearance settings support light, dark and scheduled automatic modes, with customizable semantic colors. Exact untouched earlier defaults migrate to the blue palette; custom palettes remain intact.

Updated surfaces include conversations, profile, appearance, friends and invitations, groups, app lock, calls, connection setup, notifications and updates. The invitation and download pages use the same blue visual identity. The README links to Android downloads and the hosted desktop web app.

Sticker collections start empty. Users create compact raster stickers from their own photos; metadata is removed locally before delivery through encrypted direct or group chats. Sent stickers can be reused from saved conversation history. Emoji remain available. Legacy sticker message IDs remain readable for upgrade compatibility, without bundling or displaying the previous sticker artwork.

## Design references

Reviewed on 18 October 2026:

- [Apple: Layout](https://developer.apple.com/design/human-interface-guidelines/layout) — clear ordering, alignment, grouping and adaptation to available space.
- [Apple: Typography](https://developer.apple.com/design/human-interface-guidelines/typography) — readable weights, a clear hierarchy and support for larger text.
- [Apple: Materials](https://developer.apple.com/design/human-interface-guidelines/materials) — keep materials in controls and preserve readable content surfaces.
- [Apple: Motion](https://developer.apple.com/design/human-interface-guidelines/motion) — brief, purposeful and interruptible feedback with reduced-motion support.
- [Apple: Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility) — contrast, labels, keyboard access and appropriately spaced controls. LinkUp prefers at least 44 × 44 interaction targets.
- [Anthropic frontend-design skill](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md) — subject-specific design, restrained decoration and visual review.
- [Vercel web-design-guidelines skill](https://github.com/vercel-labs/agent-skills/blob/main/skills/web-design-guidelines/SKILL.md) and [current review rules](https://github.com/vercel-labs/web-interface-guidelines/blob/main/command.md) — focus, long content, accessibility, motion and responsive behavior.

These references inform the application; framework-specific recommendations are translated into React Native and React Native Web equivalents. Necessary security, connection and delivery explanations remain part of the product.

## Validation

The redesign passed the existing 245-test application suite. The blue palette correction passed appearance and invitation-page tests, TypeScript and Expo lint. Browser checks covered 1280 × 720 desktop, a short 1280 × 540 window, 390 × 844 phones in light and dark mode, and a compact 320 × 568 conversation. Preview message sending, history search, appearance saving and keyboard focus were verified.

Screenshots in `../docs/screenshots/` show the current desktop and phone layouts rendered in a responsive browser with sample conversations.

Android releases use the existing signing certificate and publisher trust. The release build verifies its JavaScript/source map, package metadata, native dependencies, APK checksum and signature. Native device launch testing requires a connected device.

The 0.3.4 cleanup passed all 248 application tests, including custom-sticker format bounds and encrypted delivery in direct and group chats. The web export uses a build-only subpath for GitHub Pages; native routing is unchanged.
