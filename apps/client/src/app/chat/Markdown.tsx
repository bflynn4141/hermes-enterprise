// Rendering the safe Markdown subset.
//
// Every element this file can produce is written out below. There is no
// `dangerouslySetInnerHTML`, no anchor, and no element chosen from data: a node
// kind the parser cannot produce is a node kind that cannot be rendered, and a
// string always arrives as a React child, which escapes it.
//
// The one node that needed a decision is `link`. The plan's rule is that a
// model-authored string is plain text with no markdown links (plan §4), and
// `packages/shared/plain-text.ts` still enforces exactly that for every string
// a *tool* writes. Chat prose is the other half: a reply may use light Markdown
// now (decision C39), and a link in it is rendered as its label followed by a
// chip carrying the bare URL — visible, selectable, copyable, and not a click
// target. A `javascript:` or `data:` href never even gets the chip: the label
// and the raw target are shown as the text they are.
import { CodeBlock } from '@hermes/motion-components';
import { isDisplayableUrl, parseMarkdown, type Block, type Inline } from './markdown-subset.js';

function InlineNodes({ nodes }: { nodes: readonly Inline[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.type) {
          case 'text':
            return <span key={index}>{node.value}</span>;
          case 'strong':
            return (
              <strong key={index}>
                <InlineNodes nodes={node.children} />
              </strong>
            );
          case 'em':
            return (
              <em key={index}>
                <InlineNodes nodes={node.children} />
              </em>
            );
          case 'code':
            return (
              <code key={index} className="md-code">
                {node.value}
              </code>
            );
          case 'link':
            return <LinkText key={index} label={node.label} href={node.href} />;
          default:
            return null;
        }
      })}
    </>
  );
}

/**
 * A link, as text.
 *
 * The label reads as the model wrote it; the destination is shown beside it,
 * because the whole point of refusing the anchor is that the human decides
 * where they are going. A label identical to the href renders once rather than
 * twice — a bare URL the model wrote out is already the URL confirmation.
 */
function LinkText({ label, href }: { label: string; href: string }) {
  const displayable = isDisplayableUrl(href);
  if (!label) return <span className="md-url">{href}</span>;
  if (!displayable) {
    // Neither the label alone (which hides the target) nor a chip (which
    // dignifies it): both, as text, so the reader sees what was written.
    return (
      <span>
        {label} <span className="md-url md-url-refused">{href}</span>
      </span>
    );
  }
  if (label.trim() === href.trim()) return <span className="md-url">{href}</span>;
  return (
    <span>
      {label} <span className="md-url">{href}</span>
    </span>
  );
}

function BlockNode({ block }: { block: Block }) {
  switch (block.type) {
    case 'paragraph':
      return (
        <p className="md-p">
          <InlineNodes nodes={block.children} />
        </p>
      );
    case 'heading': {
      const Tag = (['h1', 'h2', 'h3'] as const)[block.level - 1]!;
      return (
        <Tag className={`md-h md-h${block.level}`}>
          <InlineNodes nodes={block.children} />
        </Tag>
      );
    }
    case 'list':
      return block.ordered ? (
        <ol className="md-list" start={block.start}>
          {block.items.map((item, index) => (
            <li key={index}>
              <InlineNodes nodes={item} />
            </li>
          ))}
        </ol>
      ) : (
        <ul className="md-list">
          {block.items.map((item, index) => (
            <li key={index}>
              <InlineNodes nodes={item} />
            </li>
          ))}
        </ul>
      );
    case 'code':
      return (
        <div className="md-code-block hermes-ui">
          <CodeBlock
            variant="Code"
            lines={block.value.split('\n')}
            code={block.value}
            filename={block.language ?? 'code'}
            diff={[]}
          />
        </div>
      );
    case 'quote':
      return (
        <blockquote className="md-quote">
          {block.children.map((child, index) => (
            <BlockNode key={index} block={child} />
          ))}
        </blockquote>
      );
    case 'table':
      return (
        <div className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {block.header.map((cell, index) => (
                  <th key={index}>
                    <InlineNodes nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, index) => (
                    <td key={index}>
                      <InlineNodes nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return null;
  }
}

/**
 * The accumulated text, rendered.
 *
 * Called on every delta. It re-parses the whole string each time rather than
 * appending to a tree, which is what keeps a `**` that turns out to be emphasis
 * two characters later from having been rendered as two stars and then removed:
 * the tree is always the tree for the text as it stands.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseMarkdown(text);
  return (
    <div className={className ? `md ${className}` : 'md'}>
      {blocks.map((block, index) => (
        <BlockNode key={index} block={block} />
      ))}
    </div>
  );
}
