"use client";

import type { WalletView } from "@futbolsa/contracts";
import { useEffect, useState } from "react";

/** O que o jogador tem de um clube: ações (todas, inclusive as presas em ordens de venda), as que estão em ordens e o preço médio. */
export interface MyPosition {
  shares: number;
  inOrders: number;
  averagePrice: number;
}

/** Sem ações do clube (o jogador tem carteira, mas não tem posição nele). */
export const NO_POSITION: MyPosition = { shares: 0, inOrders: 0, averagePrice: 0 };

/** As posições da carteira por ticker. */
export type MyPositions = ReadonlyMap<string, MyPosition>;

export function positionsOf(view: Pick<WalletView, "positions">): MyPositions {
  return new Map(view.positions.map((p) => [p.club.ticker, { shares: p.shares, inOrders: p.inOrders, averagePrice: p.averagePrice }]));
}

/**
 * As posições do jogador, lidas de `GET /portfolio` ao abrir a tela. `null` enquanto carrega, sem login ou sem carteira
 * (a tela então não mostra posição nenhuma, em vez de mostrar zero).
 */
export function usePositions(api: { wallet(): Promise<Pick<WalletView, "positions">> }, logged: boolean): MyPositions | null {
  const [positions, setPositions] = useState<MyPositions | null>(null);
  useEffect(() => {
    if (!logged) {
      setPositions(null);
      return;
    }
    let alive = true;
    Promise.resolve()
      .then(() => api.wallet())
      .then(
        (view) => alive && setPositions(positionsOf(view)),
        () => alive && setPositions(null),
      );
    return () => {
      alive = false;
    };
  }, [api, logged]);
  return positions;
}
