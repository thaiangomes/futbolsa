"use client";

import { useCallback, useEffect, useState } from "react";
import { type PublicSeason, publicSeasonSchema } from "@futbolsa/contracts";
import { useSession } from "../accounts/session-provider";
import { useChannel } from "../../realtime/react";

/** O texto da faixa: o mercado todo suspenso, ou cada clube com o motivo. `null` quando nada está suspenso. */
export function suspensionNotice(data: PublicSeason | null): string[] {
  if (!data?.season) return [];
  const lines: string[] = [];
  if (data.season.suspendedReason) lines.push(`Negociação suspensa em todos os clubes: ${data.season.suspendedReason}`);
  for (const c of data.suspendedClubs) lines.push(`Negociação de ${c.ticker} suspensa: ${c.reason}`);
  return lines;
}

/**
 * A faixa de aviso que todos os jogadores veem quando a negociação de um clube ou do mercado está suspensa, com
 * o motivo (Admin, critério 23). Lê `GET /season` e, pelo canal `season`, relê quando o admin suspende ou retoma.
 */
export function SuspensionBanner() {
  const { api } = useSession();
  const [data, setData] = useState<PublicSeason | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await api.request(publicSeasonSchema, "/season"));
    } catch {
      // sem a faixa quando a API não responde: ela não é essencial
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);
  useChannel("season", { onEvent: (e) => (e.type === "market.suspended" || e.type === "market.resumed") && void load() });

  const lines = suspensionNotice(data);
  if (lines.length === 0) return null;
  return (
    <div className="note note-live" role="status" style={{ borderRadius: 0 }}>
      <div>{lines.map((l) => <div key={l}>{l}</div>)}</div>
    </div>
  );
}
