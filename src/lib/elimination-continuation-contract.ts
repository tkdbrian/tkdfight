import { z } from "zod";

export const eliminationContinuationSchema = z.strictObject({
  parentFightId: z.string().min(1).max(128),
  parentRevision: z.number().int().nonnegative(),
  proposedFight: z.strictObject({
    id: z.string().uuid(),
    red_id: z.string().min(1).max(128),
    blue_id: z.string().min(1).max(128),
    stage: z.enum(["timed-extra", "golden-point"]),
  }),
});

export type EliminationContinuationRequest = z.infer<typeof eliminationContinuationSchema>;

export interface CanonicalEliminationFight {
  id: string;
  red_id: string;
  blue_id: string;
  stage: "timed-extra" | "golden-point";
  parentFightId: string;
  parentRevision: number;
}
