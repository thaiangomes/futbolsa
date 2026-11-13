import type { AdjustBody, PlayerDetail } from "@futbolsa/contracts";
import { formatCents } from "../../lib/format";

/** A confirmação da exclusão só liga com o apelido atual digitado igual (a API confere de novo). */
export function deleteConfirmed(nickname: string | null, typed: string, reason: string): boolean {
  return nickname !== null && typed === nickname && reason.trim().length >= 3;
}

/** O que o ajuste faria, para a tela mostrar antes de enviar. `refusal` diz por que a API recusaria, pelo mesmo critério. */
export interface AdjustPreview {
  lines: string[];
  refusal: string | null;
}

/**
 * A prévia do ajuste de saldo (Admin, critérios 27 e 28): o saldo depois e, nas ações, o custo pelo preço exibido do
 * clube (o preço que a carteira já mostra, quando o jogador tem o clube). A API é quem decide (a tesouraria e as fases
 * são dela): a tela só adianta o que dá para saber do detalhe do jogador.
 */
export function previewAdjust(detail: PlayerDetail, body: Pick<AdjustBody, "asset" | "delta"> & { ticker?: string | undefined }): AdjustPreview {
  const wallet = detail.wallet;
  if (!wallet) return { lines: [], refusal: "O jogador ainda não tem carteira nesta temporada." };
  if (!Number.isInteger(body.delta) || body.delta === 0) return { lines: [], refusal: "Informe um valor diferente de zero." };
  if (body.asset === "cash") {
    const after = wallet.cash.total + body.delta;
    const free = wallet.cash.free;
    const refusal = body.delta < 0 && -body.delta > free ? `Só há ${formatCents(free)} de caixa livre.` : null;
    return { lines: [`Caixa: ${formatCents(wallet.cash.total)} → ${formatCents(after)}`], refusal };
  }
  const position = wallet.positions.find((p) => p.club.ticker === body.ticker);
  const held = position?.shares ?? 0;
  const free = position?.free ?? 0;
  const lines = [`${body.ticker ?? "Clube"}: ${held} → ${held + body.delta} ações`];
  if (body.delta > 0) {
    lines.push(
      position
        ? `Custo pelo preço exibido (${formatCents(position.price)}): ${formatCents(position.price * body.delta)}; o preço médio muda como numa compra.`
        : "Custo pelo preço exibido do clube no momento do crédito; o preço médio muda como numa compra.",
    );
    return { lines, refusal: null };
  }
  lines.push("O custo sai na proporção, sem resultado realizado.");
  return { lines, refusal: -body.delta > free ? `Só há ${free} ações livres (as outras estão em ordens de venda).` : null };
}
