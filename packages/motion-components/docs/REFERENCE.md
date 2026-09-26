# Beautiful UI → Hermes

Inspected September 14, 2026. Reference: https://www.beautifului.dev/. The public View code panel links the author's source at https://github.com/slev12397/beautiful-ui. Baseline commit: ff0f74d62d8be9d89bcb735b3632e31a6ccf88dc. Source is MIT, copyright 2026 Shane Levine. See LICENSE.beautiful-ui.

The library adapts all 21 catalog components. Source animation sequencing, shared keyframes and interaction geometry are retained where compatible with Hermes. The branded typography, readable minimum text size, eight-pixel action-button radius, navy surfaces and glass icons are intentional visual differences. The reference's paid Central Icons dependency is replaced with project-owned iconography; no license gate is bypassed.

Source CSS is compiled and scoped to `.hermes-ui`; it does not reset the host application's body. Only the selected gallery specimen is mounted. The provider honors OS reduced motion and the gallery's explicit setting, including CSS, Motion, custom timers and shaders.

Intentional context changes:

- Ice cream examples become proposed Hermes Partner Program workflows.
- "Approval Card" is displayed as "Decision prompt": clarifying choices do not approve admissions, signatures or payments.
- Recommendation meters describe evidence coverage, not invented AI confidence.
- The Surfer loader's video slot becomes a context preview by default. Consumers may pass a video source; no unrelated meme media is bundled.
- Agent Screen shows a Hermes workspace. Teach/capture is a labeled local simulation unless the consuming app supplies handlers; this library does not record a browser or send data.
- The gallery is a component workshop, not a connected agent runtime. Examples, transcripts, search and business records are illustrative local fixtures.

Functional fixes are allowed when the reference drops user changes, has stale callbacks, leaves invisible actions focusable, or does not provide a reduced-motion path. These take precedence over duplicating defects.
