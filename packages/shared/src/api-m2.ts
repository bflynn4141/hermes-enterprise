// The one response shape M2 adds that `entities.ts` does not already carry.
//
// Everything else the M2 routes return — sessions, messages, members,
// invitations, shares, the auth session — is already in `entities.ts`, and the
// server serves those shapes rather than a second set of its own. Two schemas
// for one payload is two contracts, and the one that drifts is always the one
// nobody is reading.
import { z } from 'zod';
import { uuidSchema } from './events.js';

/**
 * The composer's unsent text for one session and one person.
 *
 * Server-side rather than only in `localStorage`, because a draft that lives in
 * one browser is a draft that is gone when someone answers on their phone — and
 * because "your draft survived the reconnect" is the difference between a tool
 * people trust with a long reply and one they do not.
 */
export const draftSchema = z
  .object({
    session_id: uuidSchema,
    text: z.string().max(20_000),
    updated_at: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();
export type Draft = z.infer<typeof draftSchema>;
