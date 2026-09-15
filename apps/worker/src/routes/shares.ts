// `GET /shared/:token` — the one thing a share token is good for.
//
// Until now `createShare` minted a 256-bit token, stored its SHA-256 and handed
// back `${origin}/shared/${token}` — and nothing consumed it. `token_hash` was
// read by no query, and the *in-workspace* visibility predicate said "an
// unrevoked share exists on this session" without correlating the share with
// the caller or with a presented token. So creating a link share gave every
// member of the workspace read access to that session, and gave the person
// holding the link nothing but the SPA shell (security review O1).
//
// This route is the consuming half, and `routes/sessions.ts` is the other: the
// predicate is now `owner_id = me` and nothing else. The share is redeemed
// here, by the link holder, and it grants exactly one thing:
//
//   * one session, named by the share;
//   * read-only — there is no write anywhere in this file, and the viewer has
//     no composer, no Stop and no decision control;
//   * up to `message_cutoff_seq` and no further, because "a share is a snapshot
//     of a conversation, not a subscription to one"
//     (`routes/sessions.ts`, and migration 0002 on the column itself);
//   * with no socket and no `/events` replay, so O5 and O6 — the two places the
//     cutoff and the revocation were not honoured on the live path — stop being
//     reachable rather than being patched.
//
// Three details worth the words:
//
// **The tenant key is the answer, not the input.** `session_shares` is FORCEd,
// so a connection with no `app.workspace_id` reads nothing from it. Migration
// 0014 adds `share_directory`, the same platform-table pattern 0013 used for
// invitation tokens, and `hermes_share_workspace` turns a hash into one
// workspace id. Everything after that runs under that workspace's own key.
//
// **Revocation is a deleted directory row**, not a flag this route reads, so a
// revoked link stops resolving at the source. The one lag is the isolate memo
// below.
//
// **`blocks` are dropped.** A block is an instruction to the app to render
// something interactive, and the link holder is unauthenticated: there is no
// session for a command to act under, so the honest wire shape is the text and
// nothing else. It also means a model-authored block can never be rendered to
// somebody who never signed in.
import type { Context } from 'hono';
import { messageSchema, sharedSessionSchema } from '@hermes/shared';
import type { Env } from '../env.js';
import { connect, type Tx } from '../db/client.js';
import { withWorkspaceTransaction } from '../jobs.js';
import { RouteError } from './tenant.js';
import { isNavigation, serveAppShell } from './spa.js';

/** `sharedSessionSchema.messages` is capped at 500; so is the query. */
const MAX_SHARED_MESSAGES = 500;

/**
 * How long an isolate may reuse an answer it already computed.
 *
 * The viewer polls every 10 s per open tab and this route is unauthenticated,
 * so without a memo one shared link left open in twenty tabs is twenty Postgres
 * connections a poll against an origin budget of 209 — the same arithmetic that
 * produced the `/health` cache (finding F8). The cost is that a revocation can
 * take up to this long to be felt on an isolate that has already answered,
 * which is why it is seconds rather than the ten `/health` uses.
 */
const MEMO_TTL_MS = 5_000;

interface Memo {
  readonly at: number;
  readonly body: string;
  readonly etag: string;
}

const memo = new Map<string, Memo>();

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

/** One answer for "no such token", "revoked" and "the session went away". */
const gone = (): RouteError => new RouteError('this link is not available', 'share_unavailable', 404);

interface ShareRow {
  session_id: string;
  message_cutoff_seq: number;
  title: string;
  workspace_name: string;
}

async function loadShare(tx: Tx, workspaceId: string, tokenHash: string): Promise<ShareRow> {
  const { rows } = await tx.query<ShareRow>(
    `SELECT sh.session_id, sh.message_cutoff_seq, s.title, w.name AS workspace_name
       FROM session_shares sh
       JOIN sessions s ON s.id = sh.session_id
       JOIN workspaces w ON w.id = sh.workspace_id
      WHERE sh.workspace_id = $1 AND sh.token_hash = $2 AND sh.revoked_at IS NULL`,
    [workspaceId, tokenHash],
  );
  const row = rows[0];
  if (!row) throw gone();
  return row;
}

export async function sharedSession(c: Context<{ Bindings: Env }>): Promise<Response> {
  // `/shared/:token` is two things at one URL: a browser navigating to the link
  // wants the SPA, and the viewer the SPA then mounts wants this JSON. The
  // catch-all already knows how to tell them apart (decision F1), so this route
  // asks it rather than inventing a second rule.
  if (isNavigation(c.req.raw)) return serveAppShell(c);

  const token = (c.req.param('token') ?? '').trim();
  // Shape only. A token this route has never minted is refused before it costs
  // a connection, and the refusal is the same one a revoked link gets.
  if (!/^[A-Za-z0-9_-]{16,200}$/.test(token)) throw gone();
  const tokenHash = await sha256Hex(token);

  const cached = memo.get(tokenHash);
  const now = Date.now();
  if (cached && now - cached.at < MEMO_TTL_MS) return answer(c, cached);
  if (memo.size > 500) memo.clear();

  let workspaceId: string;
  const client = await connect(c.env, 'app');
  try {
    const found = await client.query<{ workspace_id: string | null }>(
      `SELECT hermes_share_workspace($1) AS workspace_id`,
      [tokenHash],
    );
    const id = found.rows[0]?.workspace_id ?? null;
    if (!id) throw gone();
    workspaceId = id;
  } finally {
    await client.end();
  }

  const view = await withWorkspaceTransaction(c.env, workspaceId, async (tx) => {
    const share = await loadShare(tx, workspaceId, tokenHash);
    const { rows } = await tx.query(
      `SELECT id, session_id, seq, role, kind, text, status, run_id, worked_ms, created_at
         FROM messages
        WHERE workspace_id = $1 AND session_id = $2 AND seq <= $3
        ORDER BY seq
        LIMIT $4`,
      [workspaceId, share.session_id, share.message_cutoff_seq, MAX_SHARED_MESSAGES],
    );
    return sharedSessionSchema.parse({
      session: {
        id: share.session_id,
        title: share.title,
        workspace_name: share.workspace_name,
      },
      messages: rows.map((row) =>
        messageSchema.parse({
          id: row.id,
          session_id: row.session_id,
          seq: row.seq,
          role: row.role,
          kind: row.kind ?? null,
          text: row.text,
          // See the header: a read-only snapshot carries no interactive block.
          blocks: [],
          status: row.status,
          run_id: row.run_id ?? null,
          worked_ms: row.worked_ms ?? null,
          at: (row.created_at as Date).toISOString(),
        }),
      ),
      message_cutoff_seq: share.message_cutoff_seq,
      revoked: false,
    });
  });

  const body = JSON.stringify(view);
  const entry: Memo = { at: Date.now(), body, etag: `"${await sha256Hex(body)}"` };
  memo.set(tokenHash, entry);
  return answer(c, entry);
}

/** 304 when the caller already has this exact transcript. */
function answer(c: Context<{ Bindings: Env }>, entry: Memo): Response {
  const headers: Record<string, string> = {
    etag: entry.etag,
    // A transcript is private to whoever holds the link; no shared cache should
    // hold a copy of it, and no browser should keep one after a revocation.
    'cache-control': 'private, no-store',
    'content-type': 'application/json; charset=UTF-8',
  };
  if (c.req.header('if-none-match') === entry.etag) return new Response(null, { status: 304, headers });
  return new Response(entry.body, { status: 200, headers });
}

/** Testing seam: the memo is per isolate and a test wants a fresh one. */
export const clearSharedSessionMemoForTests = (): void => memo.clear();
