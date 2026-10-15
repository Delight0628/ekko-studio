# Studio theme customization

Theme settings belong to the signed-in Studio user. They are independent of
Agent profiles and remain available after switching profiles. Brightness and
the Ink/Comic preset keep their existing device preference behavior.

## Configuration and inheritance

`packages/shared/theme-appearance.ts` is the validated configuration contract.
The existing `fontSize`, `textColor`, `accentColor` and uploaded background are
preserved. The new sparse `appearance` object contains `global` settings and
overrides for eight regions:

| Region | Surfaces |
| --- | --- |
| `chrome` | Navigation rail, title bar, page header |
| `sidebar` | Navigation, session, room and workflow sidebars |
| `content` | Main page, chat and workflow surfaces |
| `card` | Settings, models, profiles, tasks and other cards |
| `input` | Composer, text inputs and selections |
| `overlay` | Dialogs, drawers, popovers, menus and notifications |
| `userMessage` | User message bubbles |
| `assistantMessage` | Assistant message bubbles |

Each region can override background color, background opacity, blur, corner
radius, border color and shadow. Resolution is **local override → global
override → preset**. Missing/null properties inherit; zero is a valid explicit
value. Resetting one control removes only that override. Restoring defaults
clears all appearance overrides and the three original color/font controls;
the uploaded background retains its separate removal action.

Global settings additionally control secondary/muted/link colors, background
gradient and image fit/position/dimming, border width, control height, spacing,
chat width, font family, line height and letter spacing. Background opacity
changes the surface color's alpha, never the opacity of its text or children.
Nested translucent surfaces still composite according to normal CSS rules.

## Runtime paths

- `styles/theme-appearance.ts` resolves one configuration into CSS tokens.
- `styles/theme.ts` uses the same resolver for Naive UI overrides.
- `styles/_theme-surfaces.scss` maps region properties to native and teleported
  surfaces. Property classes exist only while the corresponding override is set.
- Existing pixel spacing/font sizes and radii use optional variables with their
  previous values as fallbacks, preserving the default preset geometry.
- `useTheme.ts` applies previews synchronously and serializes saves. Older
  responses cannot overwrite a newer preview or another user's active settings.
  A failed final save restores the last committed state. Wallpaper uploads use
  the same queue and update only their own metadata.
- `ThemeAppearanceEditor.vue` previews on `input` and saves on `change`, so
  dragging a range does not write to the server for every frame.

The server stores `appearance_json` in `user_themes` using the existing schema
migration mechanism. Writes reject unknown fields and invalid ranges/colors;
reads tolerate legacy or malformed saved fields. `background_updated_at` is a
separate image cache version: editing appearance does not download the wallpaper
again. Existing wallpaper versions migrate from the prior record timestamp.

## Special renderers and boundaries

- Xterm has a **Follow Studio theme** choice and updates its palette/font size
  live. Previously selected terminal palettes remain explicit user overrides.
- Monaco updates its theme, foreground/background, cursor, selection, font size,
  line height and letter spacing through the editor API without replacing text.
- Mermaid uses Studio colors and redraws diagrams on theme changes.
- The owned DSH frame receives validated theme tokens alongside brightness.
  Native plugins can consume these tokens; plugin-owned layouts and arbitrary
  third-party styling are not rewritten.
- Voice UI surfaces/text can follow custom backgrounds. Voice artwork, Agent
  cards' decorative illustration, logos, avatars and pet artwork retain their
  authored appearance. Circular markers and pill shapes remain circular/pill.
- Syntax highlighting, diff additions/deletions, graph category colors and
  success/error indicators retain semantic colors. Their surrounding surfaces,
  text sizing and ordinary controls follow the theme.
- External browser pages, document previews and images keep their original
  content styling. Separate native browser/screenshot windows are not DOM
  descendants of Studio and do not inherit these CSS tokens.

When adding a surface, reference its region token with a preset fallback. Do
not set `opacity` on a container to implement surface transparency. If a library
renders into a canvas or isolated document, provide an explicit theme adapter.

## Validation

`theme-appearance.test.ts`, `theme-save-order.test.ts` and `user-theme.test.ts`
cover validation, inheritance, zero values, renderer palettes, ordered saves,
rollback, account isolation and legacy wallpaper migration. `theme.spec.ts`
checks live CSS in the browser, persistence, reset, popup styling, brightness
presets and mobile layout. Source-level layout tests use
`preset-style-source.ts` to resolve optional overrides to their preset values;
they continue to verify the existing default geometry rather than requiring
literal pixels in production styles.
