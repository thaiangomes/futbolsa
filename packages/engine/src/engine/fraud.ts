import { assertCents, type Cents } from "./money.js";

/**
 * Regra do alerta de trapaça entre contas (especificação "Admin", seção "Trapaça entre contas"; T18 do Plano do
 * admin de jogadores e bots). Duas contas combinam negócios pequenos a preços que sobem de propósito para inflar
 * o patrimônio de uma delas. A regra só pega o padrão da rodada X de Calibração; quem decide é sempre o admin.
 *
 * Tudo em inteiros (centavos e milissegundos), sem ponto flutuante.
 */

/** Um negócio só é suspeito se tiver até 10 ações. */
export const FRAUD_MAX_SHARES = 10;

/** E se o preço ficar a 5% ou mais do preço exibido antes dele, em pontos-base. */
export const FRAUD_MIN_MOVE_BP = 500;

/** Três suspeitos do mesmo par, no mesmo clube, dão alerta. */
export const FRAUD_ALERT_MIN_TRADES = 3;

/** O 1º e o 3º suspeito precisam estar a no máximo 7 × 24 horas um do outro. */
export const FRAUD_ALERT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** O que a regra lê de um negócio. */
export interface FraudTrade {
  id: number;
  /** Horário do negócio (ms). */
  at: number;
  clubId: number;
  buyerWallet: number;
  sellerWallet: number;
  quantity: number;
  /** Preço do negócio (centavos). */
  price: Cents;
  /** Preço exibido antes dele (num leilão, o de antes do leilão, igual em todos os negócios dele). */
  priceBefore: Cents;
  /** Um dos lados é a casa (formador de mercado): nunca conta. */
  withHouse: boolean;
}

/** Um alerta por par e clube: todos os suspeitos que entram em alguma janela de três dentro de 7 dias. */
export interface FraudAlert {
  clubId: number;
  /** O par em ordem de id, para o par invertido ser o mesmo par. */
  walletLow: number;
  walletHigh: number;
  /** Os suspeitos do alerta, do mais antigo para o mais novo. */
  tradeIds: number[];
  firstAt: number;
  lastAt: number;
}

/**
 * Negócio suspeito: até 10 ações, sem a casa, e `|preço − preço anterior| × 100 ≥ 5 × preço anterior`. Vale para
 * cima e para baixo, inclusive em leilão. Sem preço anterior não há como medir, então não é suspeito.
 */
export function isSuspiciousTrade(t: FraudTrade): boolean {
  assertCents(t.price, "preço do negócio");
  assertCents(t.priceBefore, "preço anterior");
  if (t.withHouse) return false;
  if (t.quantity > FRAUD_MAX_SHARES || t.quantity < 1) return false;
  if (t.priceBefore <= 0) return false;
  return Math.abs(t.price - t.priceBefore) * 10_000 >= FRAUD_MIN_MOVE_BP * t.priceBefore;
}

/**
 * Acha os pares com 3 ou mais negócios suspeitos no mesmo clube em que do primeiro ao terceiro passam até
 * 7 × 24 horas. Os suspeitos de um par que cabem em alguma janela de três entram no mesmo alerta (o alerta
 * "cresce", proposta 15). A ordem de entrada não importa; a saída vem ordenada por clube e par.
 */
export function findFraudAlerts(trades: readonly FraudTrade[]): FraudAlert[] {
  const groups = new Map<string, { clubId: number; low: number; high: number; list: FraudTrade[] }>();
  for (const t of trades) {
    if (!isSuspiciousTrade(t)) continue;
    const low = Math.min(t.buyerWallet, t.sellerWallet);
    const high = Math.max(t.buyerWallet, t.sellerWallet);
    const key = `${t.clubId}|${low}|${high}`;
    let g = groups.get(key);
    if (!g) {
      g = { clubId: t.clubId, low, high, list: [] };
      groups.set(key, g);
    }
    g.list.push(t);
  }

  const alerts: FraudAlert[] = [];
  for (const g of groups.values()) {
    const list = g.list.sort((a, b) => a.at - b.at || a.id - b.id);
    const n = FRAUD_ALERT_MIN_TRADES;
    const inAlert = new Array<boolean>(list.length).fill(false);
    for (let i = 0; i + n - 1 < list.length; i++) {
      if (list[i + n - 1]!.at - list[i]!.at <= FRAUD_ALERT_WINDOW_MS) {
        for (let j = i; j < i + n; j++) inAlert[j] = true;
      }
    }
    const picked = list.filter((_, i) => inAlert[i]);
    if (picked.length === 0) continue;
    alerts.push({
      clubId: g.clubId,
      walletLow: g.low,
      walletHigh: g.high,
      tradeIds: picked.map((t) => t.id),
      firstAt: picked[0]!.at,
      lastAt: picked[picked.length - 1]!.at,
    });
  }
  return alerts.sort((a, b) => a.clubId - b.clubId || a.walletLow - b.walletLow || a.walletHigh - b.walletHigh);
}
