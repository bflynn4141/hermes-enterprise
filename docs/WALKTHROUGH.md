# Product walkthrough

A two-and-a-half-minute screen recording of the main Hermes Teams flow, made
to be narrated over. Two employees each work with their own agent. The
Partnerships Manager finds a partner and hands the deal to Finance, and
Finance returns a services agreement that is ready to sign.

## What the viewer sees

| Person | Role | Agent |
| --- | --- | --- |
| Maya Chen | Partnerships Manager | Scout |
| Alex Rivera | Finance | Ledger |

1. Maya asks Scout for partners who could run hands-on workshops in November.
2. Scout searches, reads the program criteria, checks public work, and scores
   three candidates. Each one lands in Maya's Inbox with the evidence attached.
3. Maya reviews Robin Studio and approves them.
4. Maya asks Scout to send the deal to Finance. Scout passes along the partner,
   the approved terms, and the evidence. Maya's conversation stays private.
5. The recording switches to Alex. Ledger has already checked the handoff
   against budget, vendor status, and duplicates.
6. Alex asks Ledger for the services agreement. Ledger drafts it from the
   standard template, and Alex reviews and approves the draft.
7. Back with Maya, Scout reports that Finance approved the agreement. Maya opens
   it in the Library, unsigned and ready for signature.

## Narration script

The times come from the recorded take. Every recording writes its own
`.chapters.txt` beside the video with the exact start time of each beat, so
use that file if you re-record.

| Time | On screen | Suggested narration |
| --- | --- | --- |
| 0:00 | Maya's workspace, with Scout open | Every employee gets their own agent, set up for their job. Maya runs partnerships with an agent called Scout. |
| 0:03 | Maya types a request | Maya needs someone to run developer workshops in November, and asks the way you'd ask a colleague. |
| 0:20 | Scout's tool calls tick through | Scout checks the partner pipeline, reads the program criteria, and looks at each candidate's public work. Every step is visible. |
| 0:39 | Shortlist table and three review cards | Scout comes back with a scored shortlist and a recommendation. It hasn't contacted anyone. Each candidate waits in Maya's Inbox. |
| 0:45 | Robin Studio's review | The review shows how Scout scored Robin against each criterion and which sources it used. |
| 0:52 | Maya clicks Admit | The decision is Maya's. Agents prepare the work; people approve it. |
| 0:56 | Maya asks Scout to send it to Finance | Instead of writing an email and attaching a quote, Maya asks Scout to hand the deal to Finance. |
| 1:10 | Scout's handoff reply | Finance receives the partner, the approved terms, and the evidence. Maya's conversation stays with Partnerships. |
| 1:20 | Account menu, switching to Alex | Now the same deal from Finance's side. Alex works with a Finance agent called Ledger. |
| 1:24 | Scout's message and Ledger's checks | By the time Alex looks, Ledger has already checked the budget, confirmed Robin is a new vendor who needs a W-9, and ruled out duplicates. |
| 1:32 | Alex asks for the agreement | Alex asks for the services agreement with the usual Finance terms. |
| 1:50 | Ledger's summary and the agreement card | Ledger drafts it from the standard template and confirms it matches what Maya approved. |
| 2:00 | The agreement in the Inbox | Alex reviews the parties, dates, amount, and every clause in one place. |
| 2:12 | Alex approves the draft | Approval saves the agreement. Nothing is signed or sent without a person. |
| 2:16 | Back to Maya | Maya didn't have to chase anyone. Scout reports that Finance approved the agreement. |
| 2:25 | The full agreement in the Library | The agreement is ready for Maya and Robin to sign. What used to take a week of email took a few minutes, with a person approving every step. |

## What is real and what is scripted

Everything on screen is the real Hermes Teams client, including the chat, run
steps, Inbox, review screens, approvals, person switch, and Library. The recording uses
the client's mock backend in walkthrough mode (`src/model/walkthrough.ts`):

- The agent replies and tool steps are scripted. They play by story beat, not
  by what was typed, so they don't show live model output.
- The people, companies, amounts, and documents are fictional.
- The person switch stands in for two people on two computers. In the hosted
  product, each employee signs in separately.
- The live workflow checks invoices against approved terms. It doesn't yet
  draft services agreements from a template, and it limits what Partnerships
  can see of Finance records. The walkthrough shows where the workflow goes
  next, not a live integration.

Say so when you share the video outside the team.

## Record it again

```sh
pnpm --filter @hermes/client walkthrough:record
```

The command builds the mock client, plays the story in Chromium, and writes
`apps/client/walkthrough/hermes-teams-walkthrough.mp4` (2560×1440, 30 fps) and
a `.chapters.txt` file. It needs ffmpeg. Options:

- `--out <file>` writes the video somewhere else.
- `--size 1920x1080` makes a smaller file.
- `--headed` shows the browser while it records.

To click through the story yourself, run `MOCK=1 pnpm --filter @hermes/client dev`
and open `http://127.0.0.1:4180/?walkthrough=reset`. Switch people from the
account menu at the bottom left. The prompts are in
`apps/client/scripts/record-walkthrough.mjs`.
