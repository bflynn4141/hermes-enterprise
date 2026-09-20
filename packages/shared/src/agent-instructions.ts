// Human-authored standing instructions are versioned independently of context.
import { z } from 'zod';

export const saveAgentInstructionSchema = z.object({
  text: z.string().trim().min(1).max(8000),
  expected_current_id: z.uuid().nullable(),
}).strict();
export type SaveAgentInstruction = z.infer<typeof saveAgentInstructionSchema>;
