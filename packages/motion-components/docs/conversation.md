# Conversation components

These five reusable primitives adapt Beautiful UI’s MIT licensed components to the Hermes Partner Program. Their original names and props are retained. The examples use proposed program criteria and simulated application data, and perform no outreach, admission or access changes.

## Exports and integration

Each primitive has a default export from `src/components/primitives/<Name>.tsx`. Named showcase wrappers are exported by `demo/conversation.tsx`: `ThinkingDemo`, `StreamingDemo`, `ToolsDemo`, `TasksDemo`, `ChatDemo`. `ThinkingDemo` and `TasksDemo` accept an optional `variant` for external gallery controls.

- `ThinkingState`: `variant`, `rows`, `active`, `done`, `icon`, `onSettled`; added `query`, `additionalSources`, and a controlled `stage` (0–4). `ThinkingRow` is exported. The historical `Reasoning` variant renders observable findings, not a model’s private reasoning. Pass a server-derived stage and real rows in an application; omit it to play the reference sequence.
- `StreamingText`: `content`, `sources`, `followUps`, `labels`, `loop`, `fill`, `onDone`, `onFollowUp`; added `onAction(copy | retry | helpful | collective)`. Copy writes the rendered plain text; replay resets the stream. Collective requests are callback events, not silent publication. `onDone` runs once per completed stream. Use `loop={false}` in a real thread.
- `ToolChips`: `steps`, `diffs`, `diffLines`, `labels`, `className`, `onOpenChange`, `onToggleRow`; added optional `onMore`. Diff previews open on hover, focus or tap and dismiss on Escape, scroll or resize. Hidden disclosures are inert. Header counts derive from the supplied steps. There is no unexplained “+2 more” button without an action.
- `TaskRows`: `variant`, `rows`, `labels`, `className`, `onToggleRow`; added real `failed` and `blocked` row statuses and an optional `onRetry(key)`. `sequence` is explicitly a demonstration that plays the source’s retry-to-completion sequence. Real work should receive status updates from its host. The fixture research row stays running; saving review drafts completes independently.
- `ChatComposer`: `messages`, `suggestions`, `labels`, `onSend`; added `sessionMessages`, `sessionPrompts`, `onTabChange`, `onAction(new | copy | collective | stop)`, and opt-in fixture `autoplay`. `ChatMessage.details` adds structured findings. Tabs retain separate drafts and transcripts. New session, copy, stop and Collective controls have meaningful labels. Sending uses fixture replies, not a model connection; host integration remains necessary. More than two reply sections are supported.

## Preserved motion

| Component | Reference choreography retained |
| --- | --- |
| Thinking | Header at 0ms; expands at 800ms; two rows at 1,400ms; all rows / settled header at 3,200ms; collapses at 5,800ms. Disclosure 400ms and line 500ms; rows 320ms with 120ms stagger; header shimmer 1,400ms; spinner 700ms. |
| Streaming | One token every 55ms; optional loop holds 3,400ms. Citation pop 250ms; action fade 400ms; sources disclosure 300ms; follow-up entrance 350ms with 90ms stagger. |
| Tools | One row every 700ms; diff chips after the fourth row at 3,500ms. Row entrance 300ms; chips 250ms with 80ms stagger; disclosure 300ms; preview pop 160ms. |
| Tasks | Rows enter over 450ms with 80ms stagger. Tick boundaries 600 / 1,500 / 3,900 / 5,300 / 7,700ms; research detail expands at 1,500ms, closes as retry appears at 3,900ms, draft completes at 5,300ms. Ring 1,100ms; detail 300ms with 120 + 100ms stagger; capsule radius 22→14px. |
| Chat | First reply 500ms after send, next at 1,900ms, settles at 3,100ms; additional sections use 1,200ms cadence. Replies enter in 400ms; resolving section uses opacity .55, blur .5px and scale .985 before settling. Send press scale .96. Source shell remains 288px tall. |

Main reveal curve remains `cubic-bezier(.23,1,.32,1)`. Hermes tokens supply navy, glass, indigo and typography; data, action colors and icons intentionally differ from the reference’s light ice-cream fixtures.

## Reduced motion and cleanup

The shared `useReducedMotion` hook respects the OS and gallery override. Demonstration sequences resolve immediately, streaming renders fully, rotating indicators become static, and chat settles immediately. Root `data-reduced-motion` attributes also suppress CSS transitions and entrances through the shared theme. Tool preview portals carry the same scope and setting. Timers and preview listeners are cleaned up on unmount; stopping chat clears its pending reply timer. Content changes restart streaming with fresh counts and a fresh completion event.

## Verification boundary

`npm run check` passed after all gallery modules were present. Components retain the published source animation values; root integration owns rendered desktop/narrow-width and live reference comparisons. These modules expose local interactions and simulated results. They do not connect to Hermes, share data, perform approvals, or imply that a real model produced the fixture responses.
