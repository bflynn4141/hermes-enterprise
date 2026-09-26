# Hermes controls

Six MIT Beautiful UI controls preserve the source motion sequences with Hermes surfaces, copy and iconography. Demos live in `demo/controls.tsx`; exported primitives accept data and callbacks. They never contact a model, admit a partner, sign a document, or move money.

| Control | Reference animation | Working states |
| --- | --- | --- |
| `ApprovalCard` / Decision prompt | Card 380ms reveal; 360ms vertical slide and measured height; 350ms odometer; 480ms single-choice advance; 260ms completion | Radio, multi-select, custom answers, back/next, skip, dismiss/reopen, submit/reset |
| `PromptBar` | 180ms popover; 220ms single highlight glide; 570ms left-to-right shader with 80ms outro; 900ms dictation bars with 150ms phase offsets | @ sources, / commands, model picker, independent Cloud/Local selector, file attachment/removal, growing input, keyboard send, labeled sample dictation, actual host dictation callback, optional guided demo |
| `SidebarNav` | 280ms width 224→52px; copy fades 180ms and translates 8px; search opens from a 28px control over 180ms; 180ms workspace popover | Collapse/expand, session search, session selection, workspace actions, navigation and identity footer |
| `SearchList` | 150ms clear control, 200ms rows, 250ms empty state, shared gliding highlight | Live filtering, clear, all unmatched queries, keyboard selection, callback |
| `SelectionActions` | 280ms initial hold; 220ms pop; 400ms preset expansion; 320ms measured-width transition; 700ms demo preparation; streaming reply | Explain, improve, shorten, tone, grammar, custom instruction, keep/discard/retry; async host callback and error state |
| `FineTuneCard` | 300ms segmented thumb; 200ms menu; 250ms edited indicator; 1.4s idle shimmer | Pointer scrubbing, direct numbers, arrow/shift-arrow and Home/End adjustment, bounded values, layout, type menu, emitted state |

## Reuse

- `ApprovalCard.onSubmitted(answers, customAnswers)` returns both choices and free text. This is a clarification component. Use a separate explicit outcome button for a financial, membership or access approval.
- `PromptBar` defaults to manual interaction and the project's DeepSeek 4.1 Flash fixture. `models`, `sources`, `commands`, runtime and callbacks are configurable. `onSend` receives text plus a structured submission. `onAttach` receives locally selected files. `onDictate` connects host-provided dictation; otherwise the mic control is explicitly a sample that does not access the microphone.
- `SidebarNav` accepts the workspace, navigation, sessions and callbacks. Inline UI glyphs are authored replacements; the Nous/Iris identity uses existing Hermes glass assets. No paid icon dependency or upsell remains.
- `SearchList.onSelect` emits the selected label. Arrow keys move from the input through results; Escape returns to the input.
- `SelectionActions` accepts passage/rewrite fixtures or `onRequestEdit` for actual generated text, plus `onKeep` and `onDiscard`. Keep commits the text to the local example; Discard restores it. Explain retains the original passage.
- `FineTuneCard.onChange` emits all fields, layout and type. The companion preview demonstrates the emitted state without coupling the reusable component to application layout.

## Intentional differences

The shader uses Hermes indigo, lilac and white glass colors instead of rainbow colors; its timings, band, brightness and easing remain those of the source. The composer adds a separate runtime selector required by this project. Decision completion records research preferences only. Sidebar dimensions and primary timing remain the source values, with Hermes navigation and sessions. The inspector radius starts at the Hermes 12px value.

Reduced motion uses the shared provider/OS preference and the gallery's CSS override. The shader is canceled and destroyed when motion is reduced or the component unmounts. The selection width animation uses the same preference. Timers, pointer/document handlers, observers and pending callback generations are cleaned up. Hidden sidebar/history and selection-action controls are removed from keyboard interaction.

These files were checked with TypeScript. Visual and animation comparisons are owned by the integrating showcase review; this document does not claim browser verification.
