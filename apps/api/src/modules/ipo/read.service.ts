import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import type { IpoClubResult, IpoClubView, IpoOverview, IpoResults, MyBid } from "@futbolsa/contracts";
import { placementPrice } from "@futbolsa/engine";
import { DB, type Database } from "../../infra/db/index.js";
import { clubs, ipoAllocations, ipoBids, ipoResults, seasonClubs, seasonRules, wallets } from "../../infra/db/schema/index.js";
import { leaguesFromRules } from "../dividends/season-values/mapper.js";
import { currentSeason } from "../admin/current-season.js";
import { placementUpliftPart } from "./bands.js";
import { ipoError } from "./errors.js";
import { IpoSettlementService } from "./settlement.service.js";

/**
 * A leitura do IPO para o jogador (`GET /ipo` e `GET /ipo/results`). Só lê, sem trava: a demanda e as
 * ofertas dos outros jogadores nunca entram aqui (IPO por bookbuilding, critério 15), e o esquema dos
 * contratos é estrito para um campo a mais não passar sem um teste quebrar. O que o jogador vê de si é
 * a própria oferta (ativa) e o próprio caixa.
 */
@Injectable()
export class IpoReadService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly settlement: IpoSettlementService,
  ) {}

  /**
   * `GET /ipo`: as datas, o tamanho da oferta, por clube a faixa (com a conta do centro) e a minha oferta,
   * e o meu caixa. Antes da abertura só as datas previstas, sem faixa e sem clubes.
   */
  async overview(userId: string): Promise<IpoOverview> {
    const season = await currentSeason(this.db);
    if (!season) throw ipoError("ipo_not_open");
    const [wallet] = await this.db
      .select({ id: wallets.id, cash: wallets.cash, reservedCash: wallets.reservedCash })
      .from(wallets)
      .where(and(eq(wallets.seasonId, season.id), eq(wallets.userId, userId)));

    let clubViews: IpoClubView[] = [];
    if (season.status !== "preparing") {
      const rows = await this.db
        .select({ sc: seasonClubs, ticker: clubs.ticker, name: clubs.name })
        .from(seasonClubs)
        .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
        .where(eq(seasonClubs.seasonId, season.id))
        .orderBy(asc(clubs.ticker));
      const myBids = new Map<number, MyBid>();
      if (wallet) {
        const mine = await this.db
          .select()
          .from(ipoBids)
          .where(and(eq(ipoBids.seasonId, season.id), eq(ipoBids.walletId, wallet.id), eq(ipoBids.status, "active")));
        for (const b of mine) {
          myBids.set(b.clubId, { quantity: b.quantity, maxPrice: b.maxPrice, reserved: b.reserved, updatedAt: b.updatedAt.toISOString() });
        }
      }
      // os valores da Série A da temporada dão o aumento da colocação que a faixa já traz (sem valores gravados, aumento zero)
      const [rules] = await this.db.select().from(seasonRules).where(eq(seasonRules.seasonId, season.id));
      const seasonValues = { leagues: rules ? leaguesFromRules(rules) : {}, cups: {} };
      clubViews = rows.flatMap((r) => {
        // A faixa é gravada na abertura; clube sem ela (não deveria existir com o IPO aberto) fica de fora.
        if (r.sc.bandFloor === null || r.sc.bandCenter === null || r.sc.bandCeiling === null || !r.ticker) return [];
        const base = placementPrice(r.sc.prevPlacement);
        const uplift = placementUpliftPart(r.sc.prevPlacement, seasonValues, rules?.buybackMultipleBp ?? 0);
        return [
          {
            ticker: r.ticker,
            name: r.name,
            // a parte das copas é o centro menos o preço da colocação e o aumento dela, sem coluna nova
            band: {
              floor: r.sc.bandFloor,
              center: r.sc.bandCenter,
              ceiling: r.sc.bandCeiling,
              placementPrice: base,
              ...(uplift > 0 ? { placementUplift: uplift } : {}),
              cupsPart: r.sc.bandCenter - base - uplift,
            },
            myBid: myBids.get(r.sc.clubId) ?? null,
          },
        ];
      });
    }

    return {
      status: season.status as IpoOverview["status"],
      offerSize: season.offerSize,
      opensAt: season.ipoOpensAt?.toISOString() ?? null,
      closesAt: season.ipoClosesAt?.toISOString() ?? null,
      tradingOpensAt: season.tradingOpensAt?.toISOString() ?? null,
      clubs: clubViews,
      cash: wallet ? { total: wallet.cash, reserved: wallet.reservedCash, free: wallet.cash - wallet.reservedCash } : null,
    };
  }

  /**
   * `GET /ipo/results`: `pending` enquanto o período de ofertas não fechou, `settling` enquanto falta
   * liquidar algum clube (mostrar clube a clube só faria a tela mudar aos poucos, proposta 7) e, com todos
   * liquidados, o resultado de cada clube e as minhas alocações.
   */
  async results(userId: string): Promise<IpoResults> {
    const season = await currentSeason(this.db);
    if (!season) throw ipoError("ipo_not_open");
    if (season.status === "preparing" || season.status === "ipo_open") return { status: "pending" };
    if ((await this.settlement.pendingClubs(season.id)) > 0) return { status: "settling" };

    const rows = await this.db
      .select({ result: ipoResults, ticker: clubs.ticker, name: clubs.name })
      .from(ipoResults)
      .innerJoin(clubs, eq(clubs.id, ipoResults.clubId))
      .where(eq(ipoResults.seasonId, season.id))
      .orderBy(asc(clubs.ticker));

    const [wallet] = await this.db
      .select({ id: wallets.id })
      .from(wallets)
      .where(and(eq(wallets.seasonId, season.id), eq(wallets.userId, userId)));
    const mine = new Map<number, { shares: number; paid: number; refunded: number }>();
    if (wallet) {
      const allocations = await this.db
        .select({ clubId: ipoBids.clubId, shares: ipoAllocations.shares, paid: ipoAllocations.paid, refunded: ipoAllocations.refunded })
        .from(ipoBids)
        .innerJoin(ipoAllocations, eq(ipoAllocations.bidId, ipoBids.id))
        .where(and(eq(ipoBids.seasonId, season.id), eq(ipoBids.walletId, wallet.id)));
      for (const a of allocations) mine.set(a.clubId, { shares: a.shares, paid: a.paid, refunded: a.refunded });
    }

    const clubsOut: IpoClubResult[] = rows.flatMap((r) =>
      r.ticker
        ? [
            {
              ticker: r.ticker,
              name: r.name,
              cutPrice: r.result.cutPrice,
              demandAtCut: r.result.demandAtCut,
              ratio: { num: r.result.allocationNum, den: r.result.allocationDen },
              leftoverShares: r.result.treasuryShares,
              lotShares: r.result.mmLotShares,
              myAllocation: mine.get(r.result.clubId) ?? null,
            },
          ]
        : [],
    );
    return { status: "settled", clubs: clubsOut };
  }
}
