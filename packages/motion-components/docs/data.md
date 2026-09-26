# Data and workflow components

Eight components adapted from the original Beautiful UI MIT source. Original source is retained by the project and LICENSE.beautiful-ui covers attribution. This pass changes domain copy, supplies realistic local fixtures and adds reusable action boundaries. It does not connect an agent, approve an applicant, send a message or move money.

## Preserved motion and interactions

| Component | Original sequence retained | Trigger / interruption |
|---|---|---|
| RecommendationCard | Body fade 180ms; alternatives intrinsic-height/opacity 300ms, cubic-bezier(.16,1,.3,1); meter color300ms; row hover100ms | Alternative selection changes the visible recommendation; confirm awaits callback. Busy actions cannot be repeated. |
| ContextCards | Header fade400ms; cards rise/fade400ms staggered100ms; source chips appear after700ms, scale/opacity300ms staggered80ms, cubic-bezier(.23,1,.32,1) | Mount once; sources remain available. Timer is cleaned up. Hidden chips are not tabbable. |
| DiffTable | Plain → removal tint after180ms → completed diff260ms later; added row reveal200ms; row tint150/200ms; footer fade-up180ms; saved acknowledgement pop180ms | Toggle each removal/addition, then save selected edits. Success follows onApply; errors remain retryable. |
| RecordsTable | Returned/sample cells resolve every110ms; existing cell pulse1.1s; property/add menus pop160ms; submenus140ms; switches150ms; advanced section160ms | Column sort, drag resize, pin/unpin, selection, type/model/input menus and compact/reset controls remain usable. Timers and global resize listeners clean up. |
| FilterTable | Filter chips200ms; row intrinsic-height/opacity300ms, cubic-bezier(.23,1,.32,1); hover100ms | Counts derive from supplied rows. Hidden rows are inert and removed from accessibility navigation. |
| Flowchart | Measured live connector follows pointer drag; edge/shadow150ms; dropdown pop180ms; hover follower top/height220ms and opacity150ms | Drag any node; select a step; edit conditions. Dashed return connects the repeated application loop. No workflow is activated. |
| InsightCards | Existing paused Liveline interpolation, pointer scrub tooltips and carousel; metrics150ms; allocation selection300ms with inner bar500ms; legends150ms; page container250ms | User controls pages, metric and inspected segment. No autoplay was added; original source has no active autoplay timer. |
| CodeBlock | Existing code/diff layouts, syntax and word-level diff; hover100ms; clipboard acknowledgement1500ms | Copy waits for Clipboard API success. Repeated copy resets its timer; rejection exposes a fallback instruction. |

Normal-motion constants and easing are preserved. All eight honor the shared Hermes motion provider/OS setting through the root CSS and component data flag. Context and Diff skip decorative delays under reduced motion; Records settles returned data immediately. The charts remain paused snapshots with no pulse. Browser verification of canvas interpolation under reduced motion is part of the root integration review.

## Reusable inputs and outputs

- RecommendationCard accepts options/labels, onSelect and async onConfirm. A recommendation opens a review or prepares a note; it does not admit anyone. Signal bars describe cited/partial/missing evidence, never model certainty. No callback means the primary action is disabled.
- ContextCards accepts chunks/labels and onOpenSource. Count derives from chunks unless explicitly overridden. Default sources are program criteria and Robin's delivery statement.
- DiffTable accepts rows, addedRow, title and column labels. onSelectionChange and async onApply receive explicit removed/added row objects. The example edits Iris's local evidence ordering, leaving shared Partner operations v3 unchanged. Use a new key when loading a different diff to reset local selection.
- RecordsTable accepts rows, fill, onOpenRow, onSelectionChange and async onCalculate. The calculation request includes the selected inputs, editable prompt, model, grounding and advanced constraints. Returned values map record IDs to text in the optional Review gaps column. The source table is immutable. Without onCalculate, Preview sample results reveals only supplied reviewGap fixtures; it does not simulate a real model request. Base-column recalculation remains a visual preview; applications must supply updated rows to change those values.
- FilterTable accepts rows, labels, initialFilter, onFilterChange and onOpenRow. Built-in filters distinguish Needs review, Working and Completed; only the four Needs review rows are Inbox decisions.
- Flowchart accepts steps, edges and onSelect/onMove/onConditionsChange. Custom IDs and edges are supported; unknown edges are ignored. Node movement updates connector geometry. Condition changes describe a draft, not a deployed automation.
- InsightCards accepts pages, initialPage, onPageChange and onAction. CompareCard, AnomalyCard and AllocationCard are exported for custom page data. All default charts explicitly say Illustrative and do not represent live Hermes enrollment or current Inbox counts.
- CodeBlock accepts lines/code/diff/filename/labels and onCopy/onCopyError. The partner-review TypeScript is explanatory example code, not an installed or runnable skill.

## Demo fixtures

Maya Chen owns decisions; Iris reads criteria and screens applications. Leah and Owen remain applicants with unverified customer impact. Leah's timeline is missing; Owen's capacity is unconfirmed. Robin's delivered October8 workshop ($900) and October9 resource pack ($300) are separate from future services. Noor needs a feedback destination. The records example uses these four program records and keeps source coverage qualitative.

The charts intentionally use a separate illustrative trend fixture, labeled in each card. They do not alter the four-request product story. Proposed role-mix percentages are not confirmed Partner Program terms or actual enrollments.

## Verification boundary

Source review confirmed removal of the original ice-cream defaults, retained normal-motion constants, dynamic filter counts, callback acknowledgement/error paths, timer cleanup and reduced-motion branches. Root owns TypeScript/build checks and actual browser motion/interaction review; this writer did not claim browser verification. Remaining design limitations inherited from the source: resize and diagram movement are pointer interactions; table configuration is a local draft until an application persists it; chart hover details need application-specific keyboard equivalents for production use.
