/**
 * Baixa uma competição da API pública da ESPN (sem chave, sem documentação nem termos publicados: serve para o teste da
 * partida e para calibrar, não para o jogo público) e converte para o formato de partidas do FutBolsa.
 *
 * Uso:
 *   npm run data:fetch-espn-copa -- <competição|todas> [ano] [--bruto <pasta>] [--de <pasta>] [--saida <pasta>]
 *
 * Competições: brasileirao-a (bra.1), brasileirao-b (bra.2), copa-do-brasil, libertadores e sul-americana.
 * - Sem `--de`, baixa `scoreboard?dates=<ano>&limit=1000` (uma chamada por competição) e guarda cada resposta crua em
 *   `--bruto` (padrão: `data/bruto-espn-<ano>-<data>/`). Os dados baixados não são confiáveis: a pasta tem que ser nova e vazia.
 * - Com `--de <pasta>`, não usa a rede: converte as respostas já baixadas (`<liga>.json`).
 * - Grava `<saida>/<arquivo>-<ano>.json` (padrão: `data/`).
 *
 * Os horários vêm em UTC e são gravados no horário de Brasília. Clubes de fora da Série A ganham um id próprio
 * ("EXT-LANUS"). Jogos por jogar ficam `scheduled`; adiados já remarcados valem pelo jogo remarcado (marcado `postponed`).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMPETICOES_ESPN, converterEspn, urlDoPlacar, type EspnEvent } from "../src/data/espn.js";

const args = process.argv.slice(2);
const opcao = (nome: string): string | undefined => {
  const i = args.indexOf(`--${nome}`);
  if (i < 0) return undefined;
  const valor = args[i + 1];
  args.splice(i, 2);
  return valor;
};
const bruto = opcao("bruto");
const de = opcao("de");
const saida = opcao("saida") ?? "data";
const [competicao, anoArg = "2026"] = args;
const chaves = competicao === "todas" ? Object.keys(COMPETICOES_ESPN) : competicao && COMPETICOES_ESPN[competicao] ? [competicao] : [];
if (chaves.length === 0) {
  console.error(`Uso: npm run data:fetch-espn-copa -- <${Object.keys(COMPETICOES_ESPN).join("|")}|todas> [ano] [--bruto <pasta>] [--de <pasta>] [--saida <pasta>]`);
  process.exit(1);
}
const ano = Number(anoArg);
const hoje = new Date().toISOString().slice(0, 10);

let pastaBruta = de;
if (!de) {
  pastaBruta = bruto ?? `data/bruto-espn-${ano}-${hoje}`;
  if (existsSync(pastaBruta) && readdirSync(pastaBruta).length > 0) {
    console.error(`A pasta ${pastaBruta} já tem arquivos: cada download vai para uma pasta nova e vazia.`);
    process.exit(1);
  }
  mkdirSync(pastaBruta, { recursive: true });
  for (const chave of chaves) {
    const cfg = COMPETICOES_ESPN[chave]!;
    const res = await fetch(urlDoPlacar(cfg.league, ano));
    if (!res.ok) throw new Error(`ESPN ${res.status} em ${cfg.league}`);
    writeFileSync(join(pastaBruta, `${cfg.league}.json`), await res.text());
  }
}

mkdirSync(saida, { recursive: true });
for (const chave of chaves) {
  const cfg = COMPETICOES_ESPN[chave]!;
  const texto = readFileSync(join(pastaBruta!, `${cfg.league}.json`), "utf8");
  const corpo = JSON.parse(texto) as { events?: EspnEvent[] };
  const { arquivo, resumo } = converterEspn(chave, corpo.events ?? [], ano, hoje);
  const destino = join(saida, `${cfg.arquivo}-${ano}.json`);
  writeFileSync(destino, JSON.stringify(arquivo, null, 2) + "\n");
  console.log(
    `${chave}: ${resumo.eventos} eventos → ${arquivo.matches.length} jogos (${resumo.jogados} jogados, ${resumo.porJogar} por jogar, ` +
      `${resumo.adiados} adiados, ${resumo.adiadosRemarcados} já remarcados, ${resumo.cancelados} cancelados; último jogado em ${resumo.ultimoJogado}) → ${destino}`,
  );
}
