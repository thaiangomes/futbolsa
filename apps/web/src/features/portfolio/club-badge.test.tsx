// @vitest-environment jsdom
import { BADGE_PATTERNS, CLUB_BADGES } from "@futbolsa/engine/data/clubBadges";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { useDom } from "../../test-support/dom";
import { badgeBackground, badgeOf, ClubBadge, ClubBadgeMark } from "./club-badge";

// Item 8 da fila da partida de teste: os selos com as cores, o padrão e a sigla aprovados nos protótipos (2026-11-01 e 2026-11-02).

describe("selos dos clubes", () => {
  const dom = useDom();

  it("livro 49: cada padrão tem o desenho dos protótipos (flamengo: quatro faixas iguais; são paulo: faixa fina de duas cores)", () => {
    expect(badgeBackground(CLUB_BADGES.FLA3!)).toBe("linear-gradient(180deg,#C8102E 0 25%,#111111 25% 50%,#C8102E 50% 75%,#111111 75% 100%)");
    expect(badgeBackground(CLUB_BADGES.SAO3!)).toBe("linear-gradient(180deg,#F4F4F4 0 36%,#E2231A 36% 45%,#F4F4F4 45% 51%,#111111 51% 60%,#F4F4F4 60% 100%)");
    expect(badgeBackground(CLUB_BADGES.PAL3!)).toBe("#0B6E3A"); // liso
    expect(badgeBackground(CLUB_BADGES.BAH3!)).toBe("linear-gradient(135deg,#0057B8 0 52%,#D62828 52% 100%)");
    expect(badgeBackground(CLUB_BADGES.VAS3!)).toBe("linear-gradient(135deg,#111111 0 38%,#FFFFFF 38% 58%,#111111 58% 100%)");
    expect(badgeBackground(CLUB_BADGES.GRE3!)).toContain("linear-gradient(90deg,");
    expect(badgeBackground(CLUB_BADGES.CFC3!)).toContain("linear-gradient(180deg,#F4F4F4 0 24%,#0B6E3A 24% 36%");
    expect(badgeBackground(CLUB_BADGES.CAP3!)).toContain("#C8102E 0 20%,#111111 20% 40%");
    expect(badgeBackground(CLUB_BADGES.RBB3!)).toBe("linear-gradient(180deg,#F4F4F4 0 34%,#D21034 34% 66%,#F4F4F4 66% 100%)");
  });

  it("todos os nove padrões aparecem nos clubes e todos desenham (não caem no liso por engano)", () => {
    const used = new Set(Object.values(CLUB_BADGES).map((b) => b.pattern));
    expect([...used].sort()).toEqual([...BADGE_PATTERNS].sort());
    for (const badge of Object.values(CLUB_BADGES)) {
      if (badge.pattern !== "solido") expect(badgeBackground(badge)).toContain("linear-gradient");
    }
  });

  it("usa o que veio do banco; sem as cores, busca no arquivo versionado pelo ticker; clube desconhecido sai neutro", () => {
    expect(badgeOf({ ticker: "FLA3", name: "Flamengo", colorPrimary: "#112233", colorSecondary: "#445566", badgePattern: "faixa", badgeInk: "#000000" })).toMatchObject({ primary: "#112233", secondary: "#445566", pattern: "faixa", ink: "#000000" });
    expect(badgeOf({ ticker: "FLA3", name: "Flamengo" })).toEqual(CLUB_BADGES.FLA3);
    expect(badgeOf({ ticker: "XYZ9", name: "Outro" })).toMatchObject({ primary: "#5B6676", pattern: "solido" });
    // o banco com as cores mas sem o padrão (carga antiga) completa pelo arquivo, sem perder o desenho
    expect(badgeOf({ ticker: "FLA3", name: "Flamengo", colorPrimary: "#C8102E", colorSecondary: "#111111" }).pattern).toBe("aros-grossos");
  });

  it("o selo mostra a sigla de três letras, o padrão e um rótulo com o nome, sem imagem nem escudo", async () => {
    await dom.render(createElement(ClubBadgeMark, { club: { ticker: "FLA3", name: "Flamengo" }, size: 40 }));
    const selo = dom.$("[data-testid=selo]");
    expect(selo.textContent).toBe("FLA");
    expect(selo.getAttribute("data-pattern")).toBe("aros-grossos");
    expect(selo.getAttribute("aria-label")).toBe("Selo FLA3, Flamengo");
    expect(selo.style.background).toContain("linear-gradient");
    expect(dom.$$("img")).toHaveLength(0);
  });

  it("a placa da sigla clareia quando a tinta é escura (santos e bragantino) e escurece quando é clara", async () => {
    await dom.render(createElement("div", null, createElement(ClubBadgeMark, { club: { ticker: "SAN3", name: "Santos" } }), createElement(ClubBadgeMark, { club: { ticker: "FLA3", name: "Flamengo" } })));
    const [santos, fla] = dom.$$("[data-testid=selo] > span");
    expect(santos!.style.background).toContain("255, 255, 255");
    expect(fla!.style.background).toContain("10, 12, 16");
  });

  it("o selo com nome traz o ticker e o nome ao lado", async () => {
    await dom.render(createElement(ClubBadge, { club: { ticker: "PAL3", name: "Palmeiras" } }));
    expect(dom.$("[data-testid=selo-clube]").textContent).toContain("PAL3");
    expect(dom.$("[data-testid=selo-clube]").textContent).toContain("Palmeiras");
  });
});
