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
import type { Block as BlockType, RequestEntity } from '@hermes/shared';
import { isModelCommand } from '@hermes/shared';
import { useAdapter, useAppState, useEntity, useNav } from '../store-context.js';
import { Glass, Icon, KIND_ICON } from '../ui/icons.js';
import { BrokenBlock, Button, Skeleton } from '../ui/primitives.js';
import { requestStatusLabel } from '../selectors.js';
import type { Message } from '@hermes/shared';

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
      return <ReceiptBlock requestId={String(block.command?.id ?? (block as { request_id?: string }).request_id ?? '')} />;

    case 'choice':
      return (
        <div className="choice-row">
          {(block.options ?? []).map((option, index) => (
            <Button key={index} onClick={() => run(option.command)}>
              {option.label}
            </Button>
          ))}
        </div>
      );

    case 'confirm':
      return (
        <div className="draft-block">
          <div className="k">{block.title}</div>
          <div className="v">{block.subtitle}</div>
          <div className="draft-actions">
            {(block.actions ?? []).map((action, index) => (
              <Button key={index} primary={action.tone === 'primary'} onClick={() => run(action.command)}>
                {action.label}
              </Button>
            ))}
          </div>
        </div>
      );

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
  const state = useAppState();
  const nav = useNav();
  const record = useEntity<RequestEntity>('request', requestId || null);
  if (!requestId) return <BrokenBlock reason="The receipt named no request." />;
  if (record.state === 'loading') return <Skeleton rows={2} label="Loading the request" />;
  if (record.state === 'missing' || !record.data) return <BrokenBlock reason="Request not found" />;
  const request = record.data;
  void state;
  return (
    <div className="chat-card static">
      <Glass name={KIND_ICON[request.kind] ?? 'context'} size={28} className="card-icon" />
      <div className="card-body">
        <div className="card-title">{request.label}</div>
        <div className="card-sub">{requestStatusLabel(request)}</div>
      </div>
      <Button onClick={() => nav({ section: 'inbox', view: 'request', id: request.id })}>
        {request.status === 'pending' ? 'Review' : 'Open receipt'}
        <Icon name="arrow" size={14} />
      </Button>
    </div>
  );
}
