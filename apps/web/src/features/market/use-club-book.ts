"use client";

import { clubChannel, type BookView } from "@futbolsa/contracts";
import { useSyncedChannel } from "../../realtime/react";
import type { MarketApi } from "./api";
import { applyClubEvent, type ClubState } from "./club-state";
import type { SyncedSnapshot } from "../../realtime/synced-channel";

/**
 * O estado da tela do clube: o livro, os últimos negócios, o preço, o modo de jogo e o leilão, lidos de
 * `GET /clubs/:ticker/book` e mantidos pelo canal `club:<ticker>` sem recarregar a página (critério 35).
 * O `seq` do canal vem na própria resposta, lido pela API antes do banco: o que chegar durante a carga é
 * aplicado só se tiver `seq` maior, e um negócio repetido não aparece duas vezes (`mergeTrades`).
 */
export function useClubBook(api: MarketApi, ticker: string | null): SyncedSnapshot<ClubState> {
  return useSyncedChannel<ClubState>(
    ticker ? clubChannel(ticker) : null,
    async () => {
      const view: BookView = await api.book(ticker!);
      return { state: view, seq: view.seq };
    },
    applyClubEvent,
  );
}
