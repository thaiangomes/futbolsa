// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { scriptDoRelogioPublico } from "./relogio-publico";

// F17, T9: o script que põe a hora do jogo no site da Vercel.
const DateOriginal = Date;
afterEach(() => {
  vi.unstubAllGlobals();
  window.Date = DateOriginal;
  vi.useRealTimers();
});

function rodar(resposta: { status: number; corpo: string }) {
  const pedidos: string[] = [];
  class XHR {
    status = resposta.status;
    responseText = resposta.corpo;
    open(_m: string, url: string, assincrono: boolean) {
      pedidos.push(`${url} ${assincrono ? "async" : "sync"}`);
    }
    send() {}
  }
  vi.stubGlobal("XMLHttpRequest", XHR);
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
  // eslint-disable-next-line no-new-func
  new Function(scriptDoRelogioPublico("https://api.exemplo.ngrok-free.app/"))();
  return pedidos;
}

describe("relógio do jogo no site público", () => {
  const sim = Date.parse("2026-01-14T22:00:00Z");

  it("pausado: Date.now() e new Date() ficam no instante do jogo", () => {
    const pedidos = rodar({ status: 200, corpo: JSON.stringify({ sim, run: false }) });
    expect(pedidos).toEqual(["https://api.exemplo.ngrok-free.app/partida/hora sync"]);
    expect(Date.now()).toBe(sim);
    expect(new Date().toISOString()).toBe("2026-01-14T22:00:00.000Z");
    expect(new Date("2027-01-01T00:00:00Z").getUTCFullYear()).toBe(2027);
    expect(new Date(2026, 0, 1) instanceof DateOriginal).toBe(true);
  });

  it("tempo real: anda junto com o relógio de verdade", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new DateOriginal("2030-05-05T10:00:00Z"));
    rodar({ status: 200, corpo: JSON.stringify({ sim, run: true }) });
    vi.setSystemTime(new DateOriginal("2030-05-05T10:00:10Z"));
    expect(Date.now()).toBe(sim + 10_000);
  });

  it("API fora do ar: o Date fica como está", () => {
    rodar({ status: 503, corpo: "{}" });
    expect(window.Date).toBe(DateOriginal);
  });
});
