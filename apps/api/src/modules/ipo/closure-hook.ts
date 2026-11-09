import { Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { Clock } from "../../infra/clock/index.js";
import type { Tx } from "../../infra/db/index.js";
import { seasons, wallets } from "../../infra/db/schema/index.js";
import type { ClosureHook, ClosureReason } from "../accounts/index.js";
import { IpoBidsService } from "./bids.service.js";

/**
 * O que o IPO faz quando uma conta é excluída (F5) ou bloqueada (F14): o gancho de encerramento que o
 * `IpoModule` registra no `AccountClosureHooks` (A6; proposta 8 do Plano do IPO).
 *
 * - Oferta não trava clube (a faixa não muda depois da abertura e as ofertas de um clube não disputam
 *   nada até a liquidação): `clubsToLock` é vazio.
 * - Com o IPO aberto, as ofertas ativas da carteira são canceladas e a reserva volta ao caixa livre, como
 *   no `DELETE` da oferta. Vale só o status da temporada: com `ipo_open`, o fechamento ainda não
 *   aconteceu (ele espera a trava exclusiva), então a oferta sai antes de existir o livro final.
 * - Com qualquer outro status não faz nada. Entre o fechamento e a liquidação, tirar uma oferta mudaria
 *   o rateio dos outros: ela entra no rateio como estava; o bloqueado fica com as ações (continua dono)
 *   e as do excluído vão para a tesouraria pelo `account-closeout` da F5. Depois da liquidação não há
 *   mais oferta ativa.
 */
@Injectable()
export class IpoClosureHook implements ClosureHook {
  constructor(
    private readonly bids: IpoBidsService,
    private readonly clock: Clock,
  ) {}

  async clubsToLock(_tx: Tx, _walletId: number): Promise<string[]> {
    return [];
  }

  /**
   * Exige a temporada da carteira já travada por quem chama (o encerramento trava a temporada antes da
   * carteira): é a trava que impede o fechamento de acontecer entre a leitura do status e o cancelamento.
   * O motivo (`deleted` ou `blocked`) não muda nada aqui.
   */
  async cancelOpen(tx: Tx, walletId: number, _reason: ClosureReason): Promise<void> {
    const [owner] = await tx.db.select({ seasonId: wallets.seasonId }).from(wallets).where(eq(wallets.id, walletId));
    if (!owner) throw new Error(`carteira inexistente: ${walletId}`);
    if (!tx.locks.isSeasonLocked(owner.seasonId)) {
      throw new Error(
        `o gancho do IPO exige a temporada ${owner.seasonId} já travada por quem chama: sem a trava, o IPO pode fechar ` +
          "entre a leitura do status e o cancelamento das ofertas",
      );
    }
    const [season] = await tx.db.select({ status: seasons.status }).from(seasons).where(eq(seasons.id, owner.seasonId));
    if (season?.status !== "ipo_open") return;
    await this.bids.cancelLocked(tx, { walletId, at: this.clock.now() });
  }
}
