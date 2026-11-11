import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import {
  changeBp,
  clubsInMatch,
  dayOpenPrice,
  displayedPrice,
  displayedPriceOf,
  displayedPrices,
  inMatch,
  matchModeOf,
  tradingGate,
} from "../../src/modules/market/index.js";
import { useTestDatabase } from "../support/db.js";
import { insertMatch, insertTrade, marketSeason, tradeWallets, type MarketSeason } from "./helpers.js";

// T2 do Plano do livro de ofertas e formador: o estado do mercado lido sem trava.

const at = (iso: string) => new Date(iso);

describe("preço exibido (puro)", () => {
  it("livro 9: sem negócio, o preço exibido é o do IPO", () => {
    expect(displayedPriceOf({ lastPrice: null, ipoPrice: 3500 })).toBe(3500);
  });

  it("com negócio (ou o preço de corte que a F8 grava em last_price), vale o último preço", () => {
    expect(displayedPriceOf({ lastPrice: 4300, ipoPrice: 3500 })).toBe(4300);
  });

  it("clube sem preço de IPO nem negócio é erro de programação", () => {
    expect(() => displayedPriceOf({ lastPrice: null, ipoPrice: null })).toThrow();
  });

  it("livro 20: de R$ 40,00 para R$ 42,00 são +5,00% (500 centésimos de ponto)", () => {
    expect(changeBp(4200, 4000)).toBe(500);
    expect(changeBp(3800, 4000)).toBe(-500);
    expect(changeBp(4000, 4000)).toBe(0);
    // arredonda para o mais perto, metade para longe do zero: 1 centavo em R$ 30,00 = 0,0333...% → 3
    expect(changeBp(3001, 3000)).toBe(3);
    expect(changeBp(2999, 3000)).toBe(-3);
    expect(changeBp(1, 3)).toBe(-6667);
  });
});

describe("tradingGate (puro)", () => {
  const open = new Date("2027-04-05T13:00:00Z"); // 10h de Brasília
  const season = { status: "trading", tradingOpensAt: open, tradingEndedAt: null, suspendedReason: null };
  const club = { suspendedReason: null };

  it("livro 21: 9h59 dá market_closed e 10h00 abre", () => {
    expect(tradingGate(season, club, at("2027-04-05T12:59:59Z"))).toEqual({ open: false, code: "market_closed" });
    expect(tradingGate(season, club, at("2027-04-05T13:00:00Z"))).toEqual({ open: true });
  });

  it("livro 22: domingo às 3h de Brasília está aberto", () => {
    expect(tradingGate(season, club, at("2027-04-11T06:00:00Z"))).toEqual({ open: true }); // domingo
  });

  it("antes da abertura (IPO ainda não liquidado) e depois do fim, market_closed", () => {
    for (const status of ["preparing", "ipo_open", "ipo_closed", "trading_ended", "closed"]) {
      expect(tradingGate({ ...season, status }, club, at("2027-05-01T13:00:00Z"))).toEqual({ open: false, code: "market_closed" });
    }
    // trading_ended_at gravado fecha mesmo que o status ainda não tenha mudado
    expect(tradingGate({ ...season, tradingEndedAt: at("2027-12-19T22:00:00Z") }, club, at("2027-12-19T22:00:00Z"))).toEqual({
      open: false,
      code: "market_closed",
    });
    expect(tradingGate({ ...season, tradingEndedAt: at("2027-12-19T22:00:00Z") }, club, at("2027-12-19T21:59:59Z"))).toEqual({ open: true });
  });

  it("admin 23: clube suspenso dá club_suspended com o motivo; o mercado todo suspenso também", () => {
    expect(tradingGate(season, { suspendedReason: "Placar errado" }, at("2027-05-01T13:00:00Z"))).toEqual({
      open: false,
      code: "club_suspended",
      reason: "Placar errado",
    });
    expect(tradingGate({ ...season, suspendedReason: "Manutenção" }, club, at("2027-05-01T13:00:00Z"))).toEqual({
      open: false,
      code: "club_suspended",
      reason: "Manutenção",
    });
  });

  it("mercado fechado vence a suspensão (não há o que suspender antes da abertura)", () => {
    expect(tradingGate({ ...season, status: "ipo_closed" }, { suspendedReason: "x" }, at("2027-04-04T13:00:00Z"))).toEqual({
      open: false,
      code: "market_closed",
    });
  });
});

describe("modo de jogo (puro)", () => {
  const kickoff = at("2027-05-01T19:00:00Z"); // 16h de Brasília
  it("livro 26: liga no horário marcado e só desliga quando o placar entra (jogo finished)", () => {
    expect(matchModeOf([{ kickoff, status: "scheduled" }], at("2027-05-01T18:59:59Z"))).toBe(false);
    expect(matchModeOf([{ kickoff, status: "scheduled" }], at("2027-05-01T19:00:00Z"))).toBe(true);
    // 18h00 (21h UTC): o jogo acabou às 17h55, mas o placar ainda não entrou
    expect(matchModeOf([{ kickoff, status: "scheduled" }], at("2027-05-01T21:00:00Z"))).toBe(true);
    // 18h40: placar importado
    expect(matchModeOf([{ kickoff, status: "finished" }], at("2027-05-01T21:40:00Z"))).toBe(false);
  });

  it("jogo adiado ou cancelado não liga o modo de jogo", () => {
    expect(matchModeOf([{ kickoff, status: "postponed" }], at("2027-05-01T20:00:00Z"))).toBe(false);
    expect(matchModeOf([{ kickoff, status: "cancelled" }], at("2027-05-01T20:00:00Z"))).toBe(false);
  });
});

describe("estado do mercado no banco", () => {
  const t = useTestDatabase();
  let s: MarketSeason;
  let wallets: { buyer: number; seller: number };

  beforeAll(async () => {
    s = await marketSeason(t.db);
    wallets = await tradeWallets(t.db, s.seasonId);
  });

  const fla = () => s.clubIds.get("FLA3")!;
  const pal = () => s.clubIds.get("PAL3")!;
  const trade = (clubId: number, iso: string, price: number) =>
    insertTrade(t.db, { seasonId: s.seasonId, clubId, at: at(iso), price, quantity: 10, buyerWalletId: wallets.buyer, sellerWalletId: wallets.seller });

  it("livro 9: sem negócio, displayedPrice lê o last_price da linha do clube (o preço de corte)", async () => {
    expect(await displayedPrice(t.db, s.seasonId, "FLA3")).toBe(4000);
    expect(await displayedPrice(t.db, s.seasonId, "FLA3", at("2027-04-05T13:00:00Z"))).toBe(4000);
  });

  it("no passado, o preço é o do último negócio até o instante (ou o do IPO antes do primeiro)", async () => {
    await trade(fla(), "2027-04-05T14:00:00Z", 4100);
    await trade(fla(), "2027-04-05T15:00:00Z", 4300);
    await trade(fla(), "2027-04-05T15:00:00Z", 4350); // mesmo instante: vale o de maior id
    expect(await displayedPrice(t.db, s.seasonId, "FLA3", at("2027-04-05T13:59:59Z"))).toBe(4000);
    expect(await displayedPrice(t.db, s.seasonId, "FLA3", at("2027-04-05T14:00:00Z"))).toBe(4100);
    expect(await displayedPrice(t.db, s.seasonId, "FLA3", at("2027-04-05T14:30:00Z"))).toBe(4100);
    expect(await displayedPrice(t.db, s.seasonId, "FLA3", at("2027-04-05T15:00:00Z"))).toBe(4350);
  });

  it("displayedPrices: o preço de todos os clubes num instante, por ticker", async () => {
    await trade(pal(), "2027-04-05T16:00:00Z", 3000);
    const prices = await displayedPrices(t.db, s.seasonId, at("2027-04-05T16:30:00Z"));
    expect(prices.get("FLA3")).toBe(4350);
    expect(prices.get("PAL3")).toBe(3000);
    expect(prices.get("SPT3")).toBe(4000); // sem negócio: o do IPO
    expect([...prices.keys()].sort()).toEqual(["COR3", "FLA3", "PAL3", "SPT3"]);
    const early = await displayedPrices(t.db, s.seasonId, at("2027-04-05T13:30:00Z"));
    expect(early.get("FLA3")).toBe(4000);
    expect(early.get("PAL3")).toBe(4000);
  });

  it("livro 20: R$ 40,00 às 0h e R$ 42,00 agora dão +5,00%; a virada do dia é às 3h UTC", async () => {
    await trade(fla(), "2027-04-06T02:59:59Z", 4000); // ainda é 5/4 em Brasília
    await trade(fla(), "2027-04-06T12:00:00Z", 4200);
    const now = at("2027-04-06T13:00:00Z");
    expect(await dayOpenPrice(t.db, s.seasonId, "FLA3", now)).toBe(4000);
    expect((await displayedPrice(t.db, s.seasonId, "FLA3", now)) === 4200).toBe(true);
    expect(changeBp(4200, await dayOpenPrice(t.db, s.seasonId, "FLA3", now))).toBe(500);
    // um negócio exatamente às 0h ainda é o preço exibido às 0h
    await trade(pal(), "2027-04-06T03:00:00Z", 3300);
    expect(await dayOpenPrice(t.db, s.seasonId, "PAL3", at("2027-04-06T10:00:00Z"))).toBe(3300);
  });

  it("livro 26: o modo de jogo liga no início marcado e só desliga com o placar", async () => {
    const kickoff = at("2027-05-01T19:00:00Z");
    const matchId = await insertMatch(t.db, { seasonId: s.seasonId, homeClubId: fla(), awayClubId: pal(), kickoff });
    expect(await inMatch(t.db, s.seasonId, fla(), at("2027-05-01T18:59:59Z"))).toBe(false);
    expect(await inMatch(t.db, s.seasonId, fla(), at("2027-05-01T19:00:00Z"))).toBe(true);
    expect(await inMatch(t.db, s.seasonId, pal(), at("2027-05-01T21:00:00Z"))).toBe(true); // 18h, placar ainda não entrou
    expect((await clubsInMatch(t.db, s.seasonId, at("2027-05-01T21:00:00Z"))).sort()).toEqual([fla(), pal()].sort());
    expect(await inMatch(t.db, s.seasonId, s.clubIds.get("SPT3")!, at("2027-05-01T21:00:00Z"))).toBe(false);
    await t.db.execute(sql`update futbolsa.matches set status = 'finished', finished_at = '2027-05-01T21:40:00Z' where id = ${matchId}`);
    expect(await inMatch(t.db, s.seasonId, fla(), at("2027-05-01T21:40:00Z"))).toBe(false);
    expect(await clubsInMatch(t.db, s.seasonId, at("2027-05-01T21:40:00Z"))).toEqual([]);
  });

  it("jogo adiado ou cancelado não liga o modo de jogo no banco", async () => {
    await insertMatch(t.db, {
      seasonId: s.seasonId,
      homeClubId: s.clubIds.get("SPT3")!,
      awayClubId: s.clubIds.get("COR3")!,
      kickoff: at("2027-05-08T19:00:00Z"),
      status: "postponed",
      round: 2,
    });
    expect(await inMatch(t.db, s.seasonId, s.clubIds.get("SPT3")!, at("2027-05-08T20:00:00Z"))).toBe(false);
  });
});
