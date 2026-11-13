// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClient } from "../../lib/auth";
import { RequireAccount, SessionProvider } from "../accounts/session-provider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));

// F14, T30: o aviso do admin vem antes de qualquer tela, até o jogador confirmar (Admin 43).

const notice = {
  id: 7,
  kind: "fraud_warning",
  createdAt: "2027-05-20T15:00:00.000Z",
  body: { reason: "preços combinados no SPT3", trades: [{ at: "2027-05-20T14:00:00.000Z", ticker: "SPT3", quantity: 1, price: 770, value: 770 }] },
};
const meWith = (pendingNotices: unknown[]) => ({
  registered: true,
  id: "u1",
  nickname: "anagol",
  email: "ana@exemplo.com",
  role: "player",
  status: "active",
  termsAcceptedAt: "2027-03-20T12:00:00.000Z",
  pendingNotices,
  season: null,
});
const auth = {
  getAccessToken: async () => "token",
  onChange: () => () => undefined,
} as unknown as AuthClient;

let container: HTMLDivElement;
let root: Root;
let pending: unknown[];
let calls: string[];
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  pending = [notice];
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string }) => {
      const path = new URL(url).pathname;
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/me") return new Response(JSON.stringify(meWith(pending)), { status: 200, headers: { "content-type": "application/json" } });
      pending = [];
      return new Response(JSON.stringify({ readAt: "2027-05-20T15:05:00.000Z" }), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function show() {
  await act(async () => root.render(createElement(SessionProvider, { auth, children: createElement(RequireAccount, { children: createElement("p", { id: "tela" }, "tela do jogo") }) })));
  await act(async () => undefined);
}

describe("aviso na entrada", () => {
  it("admin 43: com aviso pendente, mostra o aviso e esconde a tela até confirmar", async () => {
    await show();
    expect(container.textContent).toContain("Negócios anulados na sua conta");
    expect(container.textContent).toContain("preços combinados no SPT3");
    expect(container.textContent).toContain("SPT3");
    expect(container.textContent).toContain("R$ 7,70");
    expect(container.textContent).not.toContain("tela do jogo");

    const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Li e entendi")!;
    await act(async () => button.click());
    await act(async () => undefined);
    expect(calls).toContain("POST /me/notices/7/read");
    expect(container.textContent).toContain("tela do jogo");
  });

  it("sem aviso a tela abre direto", async () => {
    pending = [];
    await show();
    expect(container.textContent).toContain("tela do jogo");
  });

  it("o aviso de banimento tem outro título e nenhum negócio", async () => {
    pending = [{ ...notice, kind: "fraud_ban", body: { reason: "reincidência", trades: [] } }];
    await show();
    expect(container.textContent).toContain("Sua conta foi bloqueada");
    expect(container.textContent).not.toContain("Negócios anulados:");
  });
});
