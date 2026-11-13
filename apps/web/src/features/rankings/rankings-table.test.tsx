import type { RankingRow } from "@futbolsa/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RankingTable } from "./rankings-screen";

const row = (over: Partial<RankingRow>): RankingRow => ({ position: 1, walletKey: "k", displayName: "Ana", isBot: false, botLabel: null, returnBp: 800, ...over });

describe("RankingTable", () => {
  const rows = [
    row({ position: 1, walletKey: "a" }),
    row({ position: 2, walletKey: "b", displayName: "Carla", returnBp: 500 }),
    row({ position: 2, walletKey: "c", displayName: null, isBot: true, botLabel: "Bot dividendos", returnBp: 500 }),
    row({ position: 4, walletKey: "d", displayName: null, returnBp: null }),
  ];

  it("empate mostra 2º nas duas linhas, o bot vai marcado, a conta excluída e a falta de base têm o texto próprio", () => {
    const html = renderToStaticMarkup(<RankingTable rows={rows} />);
    expect(html.match(/2º/g)).toHaveLength(2);
    expect(html).toContain("4º");
    expect(html).toContain("Bot dividendos");
    expect(html).toContain("chip-bot");
    expect(html).toContain("conta excluída");
    expect(html).toContain("—");
  });

  it("a minha linha vem destacada e fixada no fim quando está fora da página", () => {
    const me = row({ position: 120, walletKey: "me", displayName: "eu" });
    const html = renderToStaticMarkup(<RankingTable rows={rows} me={me} />);
    expect(html).toContain('data-testid="my-row"');
    expect(html.indexOf("120º")).toBeGreaterThan(html.indexOf("4º"));
    expect(renderToStaticMarkup(<RankingTable rows={[...rows, me]} me={me} />).match(/my-row/g)).toHaveLength(1);
  });
});
