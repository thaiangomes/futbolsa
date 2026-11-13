import { assertCents, type Cents } from "./money.js";
import { buy, debitShares, emptyPosition, sell, type CostPosition } from "./cost.js";

/**
 * Desfazer negócios anulados por trapaça (Plano do admin de jogadores e bots, T19, propostas 17 e 18). Duas
 * contas puras, sem banco:
 * - `planAnnulment` diz, para cada negócio, quantas ações voltam e quanto dinheiro vai de volta, do mais novo
 *   para o mais antigo, e o que falta quando o comprador já não tem as ações;
 * - `replayCost` refaz o custo e o resultado realizado de uma posição como se os negócios (ou a parte deles
 *   que voltou) nunca tivessem existido.
 */

/** O negócio que se anula. */
export interface AnnulTrade {
  id: number;
  /** Horário do negócio (ms); só serve para ordenar do mais novo para o mais antigo. */
  at: number;
  clubId: number;
  buyerWallet: number;
  sellerWallet: number;
  quantity: number;
  price: Cents;
}

/** Chave das ações livres de uma carteira num clube. */
export const holdingKey = (walletId: number, clubId: number): string => `${walletId}|${clubId}`;

/** O que acontece com um negócio. */
export interface AnnulStep {
  tradeId: number;
  clubId: number;
  buyerWallet: number;
  sellerWallet: number;
  price: Cents;
  quantity: number;
  /** Ações que o comprador devolve ao vendedor. */
  returned: number;
  /** Ações que ficam com o comprador, porque ele já não as tinha livres (`quantity − returned`). */
  short: number;
  /** `returned × price`: o vendedor devolve, o comprador recebe. */
  cash: Cents;
}

export interface AnnulPlan {
  /** Do negócio mais novo para o mais antigo (empate de horário: id maior primeiro). */
  steps: AnnulStep[];
  /** O que sobra de cada negócio depois do desfazer (`short`), por id do negócio. */
  remaining: Map<number, number>;
}

/**
 * Desfaz do negócio mais novo para o mais antigo, como rebobinar: em cada um, o comprador devolve o que ainda
 * tem livre (as ações presas em venda já foram canceladas por quem chama) e o vendedor as recebe de volta, o
 * que já vale para o negócio seguinte, mais antigo. A ida e a volta entre os dois se desfaz sem faltar ação.
 * O que o comprador já não tem fica como está: ele não recebe o valor dessas ações e quem vendeu fica com o
 * dinheiro delas. A soma das ações de cada clube não muda.
 *
 * `freeShares` traz as ações livres de cada carteira em cada clube (`holdingKey`); quem não consta tem zero.
 */
export function planAnnulment(trades: readonly AnnulTrade[], freeShares: ReadonlyMap<string, number>): AnnulPlan {
  const free = new Map(freeShares);
  const ordered = [...trades].sort((a, b) => b.at - a.at || b.id - a.id);
  const ids = new Set<number>();
  const steps: AnnulStep[] = [];
  const remaining = new Map<number, number>();

  for (const t of ordered) {
    if (ids.has(t.id)) throw new Error(`Negócio repetido: ${t.id}`);
    ids.add(t.id);
    if (!Number.isSafeInteger(t.quantity) || t.quantity <= 0) throw new Error(`Quantidade inválida no negócio ${t.id}`);
    assertCents(t.price, "preço do negócio");
    if (t.price <= 0) throw new Error(`Preço inválido no negócio ${t.id}`);
    if (t.buyerWallet === t.sellerWallet) throw new Error(`Negócio ${t.id} com a mesma carteira nos dois lados`);

    const buyerKey = holdingKey(t.buyerWallet, t.clubId);
    const sellerKey = holdingKey(t.sellerWallet, t.clubId);
    const buyerFree = Math.max(0, free.get(buyerKey) ?? 0);
    const returned = Math.min(t.quantity, buyerFree);
    free.set(buyerKey, buyerFree - returned);
    free.set(sellerKey, (free.get(sellerKey) ?? 0) + returned);

    const short = t.quantity - returned;
    remaining.set(t.id, short);
    steps.push({
      tradeId: t.id,
      clubId: t.clubId,
      buyerWallet: t.buyerWallet,
      sellerWallet: t.sellerWallet,
      price: t.price,
      quantity: t.quantity,
      returned,
      short,
      cash: returned * t.price,
    });
  }
  return { steps, remaining };
}

/** Uma linha do histórico de uma posição, na ordem em que aconteceu. */
export interface ReplayEntry {
  /** Ações que entram (positivo) ou saem (negativo) da posição. */
  sharesDelta: number;
  /** Preço do movimento (obrigatório quando há ações, menos no débito do admin). */
  price?: Cents;
  /** O ajuste de ações do admin que tira ações (débito) não realiza resultado. */
  debit?: boolean;
  /** O negócio a que a linha se refere, para valer só a parte que não foi desfeita. */
  tradeId?: number;
}

export interface ReplayResult {
  shares: number;
  cost: Cents;
  realized: Cents;
}

/**
 * Refaz custo e resultado realizado de uma posição pelo histórico, com cada negócio anulado valendo só a
 * quantidade que ficou (`remaining`: 0 some por inteiro). As ações que entram somam ao custo, as que saem tiram
 * na proporção e realizam a diferença para o preço (ou, no débito do admin, sem resultado), como `cost.ts`.
 * As linhas `trade_annulled` não entram: o que elas desfazem já está em `remaining`.
 *
 * Falha se, no meio do caminho, a posição ficasse com ações negativas: o desfazer só devolve ações livres, então
 * isso é sinal de extrato inconsistente.
 */
export function replayCost(entries: readonly ReplayEntry[], remaining: ReadonlyMap<number, number>): ReplayResult {
  let position: CostPosition = emptyPosition();
  for (const e of entries) {
    let quantity = Math.abs(e.sharesDelta);
    if (e.tradeId !== undefined && remaining.has(e.tradeId)) quantity = Math.min(quantity, remaining.get(e.tradeId)!);
    if (quantity === 0) continue;
    if (e.sharesDelta > 0) {
      if (e.price === undefined) throw new Error("Entrada de ações sem preço no histórico");
      position = buy(position, quantity, e.price);
    } else if (e.debit) {
      if (quantity > position.shares) throw new Error("Histórico refeito com ações negativas");
      position = debitShares(position, quantity);
    } else {
      if (e.price === undefined) throw new Error("Saída de ações sem preço no histórico");
      if (quantity > position.shares) throw new Error("Histórico refeito com ações negativas");
      position = sell(position, quantity, e.price).position;
    }
  }
  return { shares: position.shares, cost: position.cost, realized: position.realized };
}
