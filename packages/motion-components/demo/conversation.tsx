import { useState } from "react";
import ThinkingState from "../src/components/primitives/ThinkingState";
import StreamingText, { type StreamingToken } from "../src/components/primitives/StreamingText";
import ToolChips from "../src/components/primitives/ToolChips";
import TaskRows from "../src/components/primitives/TaskRows";
import ChatComposer, { type ChatMessage } from "../src/components/primitives/ChatComposer";

function Controls({ variants, selected, onSelect }: { variants: string[]; selected?: string; onSelect?: (value: string) => void }) {
  return <div className="demo-variants">{variants.map((item) => <button type="button" key={item} aria-pressed={selected === item} onClick={() => onSelect?.(item)}>{item === "Reasoning" ? "Findings" : item}</button>)}</div>;
}

export function ThinkingDemo({ variant }: { variant?: string } = {}) {
  const [selected, setSelected] = useState("Steps");
  const mode = variant ?? selected;
  return <div className="demo-stack"><div className="demo-center"><ThinkingState key={mode} variant={mode} /></div>{!variant && <Controls variants={["Steps", "Reasoning", "Search", "Coding"]} selected={mode} onSelect={setSelected} />}</div>;
}

const FOLLOW_RESPONSES: Record<string, string> = {
  "Show the application evidence": "Leah attached an integration walkthrough. Owen linked a working implementation. Both need Maya’s admission review; Alex will confirm access separately.",
  "Draft a follow-up for missing details": "Here’s a draft: Thanks for applying to the Hermes Partner Program. Could you share your onboarding availability and primary technical contact? The draft is saved here for review; nothing has been sent.",
};
export function StreamingDemo() {
  const [tokens, setTokens] = useState<StreamingToken[] | undefined>();
  const [feedback, setFeedback] = useState("");
  return <div className="demo-stack"><div className="demo-center"><StreamingText content={tokens} loop={false} onFollowUp={(text) => { setTokens((FOLLOW_RESPONSES[text] ?? text).split(" ").map((word) => ({ text: word }))); setFeedback(""); }} onAction={(action) => { if (action === "collective") setFeedback("Draft selected for Collective review."); }} /></div>{feedback && <p role="status" className="text-center text-[12px] text-ink-2">{feedback}</p>}</div>;
}

export function ToolsDemo() {
  return <div className="demo-stack"><div className="demo-center"><ToolChips /></div></div>;
}

export function TasksDemo({ variant }: { variant?: string } = {}) {
  const [selected, setSelected] = useState("Capsules");
  const mode = variant ?? selected;
  return <div className="demo-stack"><div className="demo-center"><TaskRows key={mode} variant={mode} /></div>{!variant && <Controls variants={["Capsules", "List"]} selected={mode} onSelect={setSelected} />}</div>;
}

const SESSIONS: Record<string, ChatMessage[]> = {
  Applications: [
    { label: "Read applications", sub: "2 records", time: "4s", body: "Leah and Owen both included integration examples." },
    { label: "Prepared review", sub: "Iris", time: "2s", body: "Both are ready for Maya’s review. Nothing has been sent.", details: [{ label: "Admission", value: "Maya reviews" }, { label: "Access", value: "Alex confirms" }] },
  ],
  Prospects: [
    { label: "Read criteria", sub: "Program guide", time: "3s", body: "Using the proposed integration criteria." },
    { label: "Checked profiles", sub: "5 candidates", time: "8s", body: "Three profiles have relevant public implementation work. Two need stronger evidence before outreach.", details: [{ label: "Ready for review", value: "3 prospects" }, { label: "Missing evidence", value: "2 prospects" }] },
    { label: "Saved shortlist", sub: "Iris", time: "2s", body: "I’ve attached sources to each recommendation. I can draft a short introduction next; Maya reviews it before anything is sent." },
  ],
};
export function ChatDemo() {
  const [feedback, setFeedback] = useState("");
  return <div className="demo-stack"><div className="demo-center"><ChatComposer autoplay sessionMessages={SESSIONS} sessionPrompts={{ Applications: "Screen the new partner applications.", Prospects: "Find five potential integration partners. Don’t contact anyone yet." }} onAction={(action) => { if (action === "collective") setFeedback("Draft selected for Collective review."); }} /></div>{feedback && <p role="status" className="text-center text-[12px] text-ink-2">{feedback}</p>}</div>;
}
