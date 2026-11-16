// @vitest-environment jsdom
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDom } from "../../../test-support/dom";
import { PlayerHeader, type PlayerPage } from "./player-nav";

type FakeState = { status: "ready"; me: { nickname: string; role: "player" | "admin" } } | { status: "anonymous" };
let state: FakeState;
vi.mock("../session-provider", () => ({ useSession: () => ({ state }) }));

describe("menu do jogador", () => {
  const dom = useDom();
  beforeEach(() => {
    state = { status: "ready", me: { nickname: "anagol", role: "player" } };
  });
  const show = (active: PlayerPage) => dom.render(createElement(PlayerHeader, { active }));
  const links = (root: string) => dom.$$(`[data-testid=${root}] a`).map((a) => [a.textContent!.trim(), a.getAttribute("href")]);

  it("conta 28: topo do computador: Mercado, Carteira, IPO, Rankings e Competições, na ordem do protótipo, e a Conta à direita", async () => {
    await show("mercado");
    const nav = dom.$("[data-testid=menu-topo] nav");
    expect([...nav.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Mercado", "/mercado"],
      ["Carteira", "/carteira"],
      ["IPO", "/ipo"],
      ["Rankings", "/rankings"],
      ["Competições", "/competicoes"],
    ]);
    const conta = dom.$("[data-testid=menu-topo] a[href='/conta']");
    expect(conta.textContent).toContain("anagol");
    expect(conta.getAttribute("aria-label")).toBe("Minha conta, anagol");
  });

  it("abas do celular: as mesmas cinco mais o Perfil", async () => {
    await show("carteira");
    expect(links("menu-abas")).toEqual([
      ["Mercado", "/mercado"],
      ["Carteira", "/carteira"],
      ["IPO", "/ipo"],
      ["Rankings", "/rankings"],
      ["Competições", "/competicoes"],
      ["Perfil", "/conta"],
    ]);
  });

  it.each([
    ["mercado", "Mercado"],
    ["carteira", "Carteira"],
    ["ipo", "IPO"],
    ["rankings", "Rankings"],
    ["competicoes", "Competições"],
  ] as const)("a página atual (%s) fica destacada no topo e nas abas, e só ela", async (active, label) => {
    await show(active);
    for (const seletor of ["[data-testid=menu-topo] nav a[aria-current=page]", "[data-testid=menu-abas] a[aria-current=page]"]) {
      expect(dom.$$(seletor).map((a) => a.textContent!.trim())).toEqual([label]);
    }
  });

  it("na Conta, destaca o avatar e a aba Perfil, e nenhum item do menu", async () => {
    await show("perfil");
    expect(dom.$$("[data-testid=menu-topo] nav a[aria-current=page]")).toHaveLength(0);
    expect(dom.$("[data-testid=menu-topo] a[href='/conta']").getAttribute("aria-current")).toBe("page");
    expect(dom.$("[data-testid=menu-abas] a[href='/conta']").getAttribute("aria-current")).toBe("page");
  });

  it("o item Admin só aparece para o admin", async () => {
    await show("mercado");
    expect(dom.text()).not.toContain("Admin");
    state = { status: "ready", me: { nickname: "chefe", role: "admin" } };
    await show("mercado");
    expect(dom.$("[data-testid=menu-topo] nav a[href='/admin']").textContent).toBe("Admin");
  });

  it("sem sessão (mercado e rankings são públicos), oferece Entrar no lugar da Conta", async () => {
    state = { status: "anonymous" };
    await show("rankings");
    expect(dom.$("[data-testid=menu-topo] a[href='/entrar']").textContent).toBe("Entrar");
    expect(dom.$("[data-testid=menu-topo] a[href='/conta']")).toBeNull();
    expect(dom.$("[data-testid=menu-abas] a[href='/entrar']").textContent).toContain("Entrar");
  });
});
