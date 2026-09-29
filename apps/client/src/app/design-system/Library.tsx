// The design-system library: every shared primitive in its states, on one
// page, with the rule that goes with it (docs/DESIGN.md, Design system rules).
// Mock build only (`?ui=library`); a real build drops it with the mock.
import { useState, type ReactNode } from 'react';
import { BrandIcon } from '../ui/brand-icons.js';
import { Glass, Icon } from '../ui/icons.js';
import { Avatar, Button, EmptyState, Item, Pill, SearchField, Snippet, StatusDot, Tabs, ToggleGroup } from '../ui/primitives.js';
import { timeAgo } from '../ui/time.js';
import './library.css';

function Section({ title, rule, children }: { title: string; rule: string; children: ReactNode }) {
  return (
    <section className="library-section" aria-labelledby={`library-${title}`}>
      <header>
        <h2 id={`library-${title}`}>{title}</h2>
        <p>{rule}</p>
      </header>
      <div className="library-specimens">{children}</div>
    </section>
  );
}

export function DesignSystemLibrary() {
  const [tab, setTab] = useState('email');
  const [sort, setSort] = useState<'recent' | 'priority'>('recent');
  const [search, setSearch] = useState('');
  const now = Date.now();
  return (
    <div className="design-library">
      <main>
        <h1>Hermes design system</h1>
        <p className="library-lede">The shared pieces every screen is built from. <code>design-system.test.ts</code> enforces the rules it can check.</p>

        <Section title="Buttons" rule="One primary action per view. Anything that deletes, removes, disconnects, revokes or replaces is danger; its confirmation is danger primary, and focus starts on the safe choice.">
          <div className="library-row">
            <Button primary>Approve and send</Button>
            <Button>Pause</Button>
            <Button quiet>Cancel</Button>
            <Button link>Open in Inbox</Button>
          </div>
          <div className="library-row">
            <Button danger>Replace address</Button>
            <Button danger primary>Replace address</Button>
            <Button danger small>Remove</Button>
            <Button danger link>Remove limit</Button>
            <Button danger disabled>Disconnect</Button>
          </div>
          <div className="library-row">
            <Button small><Icon name="pause" size={14} />Pause</Button>
            <Button small><Icon name="play" size={14} />Resume</Button>
            <Button><BrandIcon name="google" size={16} />Connect Google</Button>
          </div>
        </Section>

        <Section title="Status" rule="A state is a dot and its word (StatusDot). Green is healthy, the accent waits for a person, amber is paused or needs a look, red failed. Only work in progress moves.">
          <div className="library-row">
            <StatusDot tone="ok" label="Receiving" />
            <StatusDot tone="ready" label="Ready for review" />
            <StatusDot tone="ok" label="Reviewed" />
            <StatusDot tone="working" label="Reading" />
            <StatusDot tone="warn" label="Paused" hint="New email is turned away until you resume." />
            <StatusDot tone="problem" label="Couldn’t read it" />
            <StatusDot tone="muted" label="No reply suggested" />
          </div>
        </Section>

        <Section title="Pills" rule="One or two words about a record, never its whole state. info for counts, warn for something to check, danger for something wrong. No pill for “Not connected”.">
          <div className="library-row">
            <Pill tone="info" icon="check">2 to do</Pill>
            <Pill tone="warn" icon="shield">Check the sender</Pill>
            <Pill tone="danger">Blocked</Pill>
            <Pill tone="ok">Owner</Pill>
            <Pill>Draft</Pill>
          </div>
        </Section>

        <Section title="Snippet" rule="A value people copy, such as an address. The copy button becomes a check for a moment; nothing else on the page changes. When it is copied more than read, use compact: one small button beside what it belongs to, which opens to show the value on hover or focus and says what it copied.">
          <div className="library-row">
            <Snippet value="iris-677gsk@in.hermes.example" label="Iris’s address" />
            <Snippet compact value="iris-677gsk@in.hermes.example" label="Iris’s email address" copiedText="Copied email address" />
          </div>
        </Section>

        <Section title="Item" rule="One row: something to recognise it by, a title with one line under it, and at most two controls.">
          <div className="library-card">
            <Item
              media={<span className="library-mark"><Glass name="iris" size={24} /></span>}
              title={<><strong>Iris</strong><StatusDot tone="ok" label="Receiving" /></>}
              description={<><span className="library-fact"><Icon name="users" size={14} />Owner reviews</span><span className="library-fact"><Icon name="mail" size={14} />4 emails</span></>}
              actions={<><Button small><Icon name="pause" size={14} />Pause</Button><Button small danger>Replace address</Button></>}
            />
            <Item
              media={<Avatar person={{ name: 'Priya Raman' }} size={32} />}
              title="September partnership invoice + co-marketing call"
              description={<>Priya Raman<Pill tone="info" icon="check">2 to do</Pill></>}
              actions={<StatusDot tone="ready" label="Ready for review" />}
            />
          </div>
        </Section>

        <Section title="Long lists" rule="A list that can grow to hundreds is one line per row, with a search box and at most a Recent / Priority toggle (ToggleGroup, not Tabs), and a Show more that says how many there are. Times are relative: Just now, 4m ago, 1d 1h 1m ago, then the date from a week on, with the exact time on hover.">
          <div className="library-row library-tools">
            <SearchField label="Search Iris’s email" value={search} onChange={setSearch} />
            <ToggleGroup label="Sort email" value={sort} onChange={setSort} options={[['recent', 'Recent'], ['priority', 'Priority']]} />
          </div>
          <div className="library-row">
            {[20_000, 4 * 60_000, 2 * 3_600_000 + 5 * 60_000, 25 * 3_600_000 + 60_000, 9 * 86_400_000].map((ms) => <Pill key={ms}>{timeAgo(new Date(now - ms).toISOString(), now)}</Pill>)}
          </div>
        </Section>

        <Section title="Tabs" rule="Moving between sibling views is always Tabs, never a dropdown. A connection’s tab carries its logo.">
          <Tabs label="Connections" value={tab} onChange={setTab} tabs={[
            { id: 'slack', label: 'Slack', brand: 'slack' },
            { id: 'email', label: 'Email', brand: 'email' },
          ]} />
        </Section>

        <Section title="Empty state" rule="Anything empty shows an icon and a short title, centered, with its one action below the words.">
          <div className="library-card">
            <EmptyState compact icon="inbox" title="No email yet" detail="Send one to the address above to try it." action={<Button small>Copy address</Button>} />
          </div>
        </Section>
      </main>
    </div>
  );
}
