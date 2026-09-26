# Verification — September 14, 2026

## Outcome

All 21 Beautiful UI catalog components are available as reusable Hermes React components and as an interactive local workshop. The main Hermes prototypes and Paper pages were not changed. Specimens use labeled local example data; no agent, payment, signature, outreach, capture or dictation service is connected.

## Reference and motion

Compared against the public source at commit `ff0f74d62d8be9d89bcb735b3632e31a6ccf88dc` and the running Beautiful UI site. All nine shared source keyframe bodies match after whitespace normalization. The nine loader cells retain their reference durations and stagger delays; eight live samples produced eight distinct opacity frames. Evidence: `qa/keyframe-comparison.json`, `qa/loader-animation.json`, `qa/loader-frames.json`.

Retained staged tool/task sequences, word streaming, thinking disclosures, prompt-menu transitions, toolbar expansion, card reveals and chart interactions. Hermes typography, gradient surfaces, readable labels, button shape and icons intentionally differ from the reference. The unrelated video example is replaced with a context preview; the component still accepts a video source. This is an animation adaptation, not a pixel-identical clone.

## Browser checks

Rendered all 21 specimens at desktop size and at an emulated 390 × 844 viewport. No page-level horizontal overflow in the narrow pass; dense tables and expanded action rows use their own horizontal scrolling. Final browser warning/error log was empty. Contact sheets, representative screenshots and measurements are in `qa/`.

Checked:

- Loading phases, pause/resume and reduced-motion states.
- Thinking variants, streamed replies, source details, tool expansion and rapid reversal.
- Chat sessions, send/stop, response copy and local Collective feedback.
- Model/runtime controls, attachment and prompt actions using example handlers.
- Decision questions, submitted answers, replay and focus movement.
- Selection actions, streamed rewrites, Keep/Discard and narrow toolbar expansion.
- Record selection, sorting, configuration and pinning; constrained desktop/phone menus.
- Status filtering, proposed-change receipts and source previews.
- Insight page navigation, code copy and diff display.
- Agent workspace open/close, demonstration controls and focus restoration.

The pass corrected portal style isolation, portable imports/assets, pause timing, stale submitted answers, retained rewrites, record pinning, menu placement, hidden-action focus, toolbar clipping and gallery scroll restoration.

## Build and reuse

`npm run build` and `npm run check` passed. The compiled package imported successfully with 27 exports (21 main components plus shared atoms/provider/helpers). Type declarations and a scoped stylesheet are included. React, React DOM and Motion are declared peer dependencies. MIT attribution accompanies adapted source and distribution.

## Limits

Phone validation used browser viewport emulation, not a physical device. Every possible variant combination and production integration has not been tested. Pointer-driven diagram/resize controls and interactive charts need a dedicated keyboard-accessibility pass before broad production use. Timing/source comparison plus rendered review does not constitute an exhaustive frame-by-frame equivalence claim. Host applications must supply real data, persistence, permissions and execution callbacks.

## Feedback polish — September 14, 2026

Status-table work, date, owner and badge text now wrap within their columns; filter controls wrap onto a new line. Rebalanced cell padding/widths prevent splitting the single-word status labels. The inspector's Adjust shimmer and icon use the existing light blue `--accent-ink` (#BBB8FF); its shimmer highlight uses `--ink`. Selected layout icons use the same legible light blue.

Verified wrapped badge bounds, complete work titles, filtering, the light gradient with its original 1.4-second animation, and 390px page width. Saved `qa/status-filters-wrapped.jpg` and `qa/inspector-blue-narrow.jpg`. Build/typecheck passed and browser warning/error log was empty.

The prompt bar now removes the bright textarea focus outline and applies focus to the composer as one object: a 50% `--accent-ink` border with a soft `--accent-tint` halo. The 150ms focus transition preserves the existing compact-control timing; reduced motion makes it immediate. Keyboard focus remains visible on the complete input surface. Verified active textarea styling, reduced-motion duration, an empty browser warning/error log, and saved `qa/prompt-focus.jpg`.

The Agent Screen preview now uses the available gallery width and increases header, navigation, content and row spacing. Its Loading state is a 400px connection surface with separate Hermes and Iris glass marks, a line reveal, a 1.55-second traveling signal, a 3.2-second Iris orbit and a 2.4-second restrained glyph pulse. The marks enter once and remain visible; only the activity indicators loop. Reduced motion removes the traveling signal, orbit and pulse while retaining both identities and the connection status. Four live samples showed the signal moving across the rail; both nodes remained fully opaque. The rendered page fit its active viewport with an empty warning/error log. Saved `qa/agent-connection-narrow.jpg`.
