import { z } from "zod";

/** `GET /admin/overview`: o que pede atenção do admin (tela inicial). */
export const overviewSchema = z.strictObject({
  pendingMatches: z.number().int(),
  standingsNotConfirmed: z.array(z.enum(["brasileirao-a", "brasileirao-b"])),
  cupsNotConfirmed: z.array(z.enum(["copa-do-brasil", "libertadores", "sulamericana"])),
  suspendedClubs: z.array(z.string()),
  marketSuspended: z.boolean(),
});
export type Overview = z.infer<typeof overviewSchema>;
