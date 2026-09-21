// Structured message blocks.
//
// Three rules, all of them load-bearing:
//   1. The block union is the contract's (`packages/shared/commands.ts`), and
//      every block is validated before it is rendered. A block that fails
//      renders "Could not display this block" — it never throws, and it never
//      renders a button whose command was rejected.
//   2. `MODEL_COMMANDS` is enforced here as well as on the server. The risk
//      this closes is a human clicking a button the model labelled "Looks good"
//      that carries `decide`: the click is real, the consent is not.
//   3. A block renders the *current* state of the object it points at, read
//      from the entity cache — the message text stays historical.
import { ApprovalCard } from '@hermes/motion-components';
import type { Block as BlockType, RequestEntity } from '@hermes/shared';
import { isModelCommand } from '@hermes/shared';
import { useAdapter, useEntity, useNav } from '../store-context.js';
import { requestInboxHighlight } from '../deep-link.js';
import { Glass, Icon, KIND_ICON } from '../ui/icons.js';
import { BrokenBlock, Button, Skeleton } from '../ui/primitives.js';
import { requestStatusLabel } from '../selectors.js';
import type { Message } from '@hermes/shared';
import { requestActionLabel, approvalActionLabel, approvalIcon, approvalReviewerLabel, approvalTypeLabel } from '../approval-copy.js';

interface BlockProps {
  block: BlockType;
  sessionId: string;
  message?: Message;
}

function commandSafe(block: BlockType): boolean {
  const commands = [block.command, block.action?.command, ...(block.actions ?? []).map((a) => a.command), ...(block.options ?? []).map((o) => o.command)].filter(Boolean);
  return commands.every((command) => isModelCommand((command as { type: string }).type));
}

export function Block({ block, sessionId, message }: BlockProps) {
  const adapter = useAdapter();
  const nav = useNav();
  const run = (command: unknown): void => adapter.applyCommand(sessionId, command as never);

  if (!commandSafe(block)) return <BrokenBlock reason="This block carried a command only a person may issue." />;

  switch (block.type) {
    case 'card':
      return (
        <div className="chat-card">
          <Glass name="context" size={28} className="card-icon" />
          <div className="card-body">
            <div className="card-title">{block.title}</div>
            {block.subtitle && <div className="card-sub">{block.subtitle}</div>}
          </div>
          {block.action && <Button onClick={() => run(block.action!.command)}>{block.action.label}</Button>}
        </div>
      );

    case 'sources':
      return (
        <div className="source-links" aria-label="Sources">
          <span className="meta">{block.subtitle ?? block.title}</span>
        </div>
      );

    case 'run-steps': {
      const steps = (message?.steps ?? []).filter(Boolean);
      if (!steps.length) return null;
      return (
        <div className="step-rows" aria-label="Completed steps">
          {steps.map((label, index) => (
            <div className="step-row" key={index}>
              <span>{label}</span>
              <span className="meta">Done</span>
            </div>
          ))}
        </div>
      );
    }

    case 'people':
      return (
        <div className="people-rows">
          <span className="meta">{block.subtitle ?? block.title}</span>
        </div>
      );

    case 'note':
      return (
        <div className="note-block">
          {block.title && <div className="t">{block.title}</div>}
          {block.subtitle && <div className="s">{block.subtitle}</div>}
        </div>
      );

    case 'guidance':
      return (
        <div className="guidance-row">
          <Glass name="loop" size={18} />
          <span>{block.title ?? 'Guidance queued'}</span>
          <span className="grow" />
          <span className="meta">{block.subtitle ?? ''}</span>
        </div>
      );

    case 'stopped':
      return (
        <div className="stopped-block">
          <div className="row">
            <Glass name="trace" size={28} />
            <div className="grow col" style={{ gap: 4 }}>
              <div>{block.title ?? 'Stopped · Completed work kept'}</div>
              <div className="meta">{block.subtitle ?? 'Sources already read are preserved'}</div>
            </div>
          </div>
        </div>
      );

    case 'error':
      return (
        <div className="error-block" role="alert">
          <div className="t">{block.title ?? 'Something went wrong'}</div>
          <div className="s">{block.subtitle}</div>
        </div>
      );

    case 'receipt':
      // The engine writes `requestId`; the planned shape was `request_id` or a
      // command carrying the id. All three are read, because the block is the
      // server's to name and the client's to render.
      return (
        <ReceiptBlock
          requestId={String(
            (block as { requestId?: string }).requestId ?? (block as { request_id?: string }).request_id ?? block.command?.id ?? '',
          )}
        />
      );

    // The two blocks `ask_for_context` produces. `ApprovalCard` carries the
    // clarifying question and nothing else: it never decides, and every command
    // it can run has already passed `commandSafe` above — a block carrying
    // `decide`, `execute`, an invitation or a role never reaches this line.
    case 'choice':
      return <ChoiceBlock block={block} run={run} />;

    case 'confirm':
      return <ConfirmBlock block={block} run={run} />;

    case 'draft':
      return (
        <div className="col" style={{ gap: 12 }}>
          <div className="draft-block">
            <div className="k">{block.title}</div>
            <div className="v">{block.subtitle}</div>
          </div>
          {block.actions && (
            <div className="draft-actions">
              {block.actions.map((action, index) => (
                <Button key={index} primary={action.tone === 'primary'} onClick={() => run(action.command)}>
                  {action.label}
                </Button>
              ))}
            </div>
          )}
        </div>
      );

    case 'plan':
      return (
        <div className="col" style={{ gap: 12 }}>
          <div className="note-block">
            <div className="t">{block.title}</div>
            {block.subtitle && <div className="s">{block.subtitle}</div>}
          </div>
          {block.action && (
            <div>
              <Button primary onClick={() => run(block.action!.command)}>
                {block.action.label}
              </Button>
            </div>
          )}
        </div>
      );

    default:
      void nav;
      return null;
  }
}

/**
 * A receipt block renders the request's *current* state from the cache. A miss
 * is a 300 ms skeleton and a fetch, never "Request not found" (spec §4.4.2).
 */
export function ReceiptBlock({ requestId }: { requestId: string }) {
  const nav = useNav();
  const record = useEntity<RequestEntity>('request', requestId || null);
  if (!requestId) return <BrokenBlock reason="The receipt named no request." />;
  if (record.state === 'loading') return <Skeleton rows={2} label="Loading the request" />;
  if (record.state === 'unavailable') return <BrokenBlock reason="Not available yet" />;
  if (record.state === 'missing' || !record.data) return <BrokenBlock reason="Request not found" />;
  const request = record.data;
  const action = request.status !== 'pending'
    ? 'Open request'
    : request.kind !== 'approval'
      ? ['invoice', 'agreement'].includes(request.kind) ? requestActionLabel(request) : 'Review'
      : request.approval?.pending_for_viewer
        ? approvalActionLabel(request)
        : 'Open request';
  return (
    <div className="chat-card static">
      <Glass name={request.kind === 'approval' ? approvalIcon(request) : KIND_ICON[request.kind] ?? 'context'} size={28} className="card-icon" />
      <div className="card-body">
        <div className="card-title">{request.label}</div>
        <div className="card-sub">{request.kind === 'approval' ? `${approvalTypeLabel(request)} · ${approvalReviewerLabel(request)}` : requestStatusLabel(request)}</div>
      </div>
      <Button
        onClick={() => {
          requestInboxHighlight(request.id);
          nav({ section: 'inbox', view: 'request', id: request.id });
        }}
      >
        {action}
        <Icon name="arrow" size={14} />
      </Button>
    </div>
  );
}


/**
 * A `choice` block: one question, the model's own option labels, and the
 * command that belongs to whichever one the person picks.
 *
 * `ApprovalCard` collects the answer and hands it back on submit, which is the
 * shape this needs: the person chooses, then confirms. Nothing runs on the
 * first click.
 */
function ChoiceBlock({ block, run }: { block: BlockType; run: (command: unknown) => void }) {
  const options = block.options ?? [];
  if (options.length === 0) return <BrokenBlock reason="This choice offered nothing to choose." />;
  return (
    <div className="hermes-ui">
      <ApprovalCard
        questions={[{ q: block.title ?? 'Which would you like?', type: 'radio', options: options.map((option) => option.label) }]}
        labels={{ continue: 'Continue', send: 'Send', sentMessage: 'Sent' }}
        onSubmitted={(answers) => {
          const picked = answers[0]?.[0];
          if (picked === undefined) return;
          run(options[picked]?.command);
        }}
      />
    </div>
  );
}

/** A `confirm` block: the same card, with the model's actions as the options. */
function ConfirmBlock({ block, run }: { block: BlockType; run: (command: unknown) => void }) {
  const actions = block.actions ?? [];
  if (actions.length === 0) return <BrokenBlock reason="This confirmation offered nothing to confirm." />;
  return (
    <div className="hermes-ui">
      <ApprovalCard
        questions={[{ q: [block.title, block.subtitle].filter(Boolean).join(' — ') || 'Confirm', type: 'radio', options: actions.map((action) => action.label) }]}
        labels={{ continue: 'Continue', send: 'Confirm', sentMessage: 'Confirmed' }}
        onSubmitted={(answers) => {
          const picked = answers[0]?.[0];
          if (picked === undefined) return;
          run(actions[picked]?.command);
        }}
      />
    </div>
  );
}
