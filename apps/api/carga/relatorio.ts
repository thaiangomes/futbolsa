import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EstatisticasDasConexoes } from "./conexoes.js";
import type { RelatorioMedidas } from "./medidores.js";
import type { ResultadoDoDegrau } from "./trafego.js";

/** O resultado de um cenário de carga: o que o gerador viu (cliente) e o que o servidor mediu (travas, atraso dos eventos). */
export interface ResultadoDoCenario {
  cenario: string;
  descricao: string;
  inicio: string;
  configuracao: Record<string, unknown>;
  degraus: ResultadoDoDegrau[];
  conexoes?: EstatisticasDasConexoes;
  servidor?: RelatorioMedidas;
  memoria?: { servidorRssMb: number; geradorRssMb: number };
  /** Resultado do verificador de invariantes no fim (`ok` ou a lista de violações). */
  invariantes: { ok: boolean; violacoes: string[] } | "nao_rodou";
  /** Medidas próprias de cada cenário (tempo da reconexão, planos de consulta etc.). */
  extras?: Record<string, unknown>;
  /** Metas da seção "Carga" do plano e o que passou. */
  metas: Array<{ meta: string; valor: string; ok: boolean }>;
  /** Aviso fixo: os números desta máquina não dimensionam o servidor. */
  aviso: string;
}

export const AVISO_DE_AMBIENTE =
  "Medido com o gerador, a API e o Postgres dividindo os mesmos núcleos de uma máquina só: serve para comparar uma execução com outra e achar gargalos de código, não para dimensionar o servidor (Azure).";

const arred = (x: number) => Math.round(x * 10) / 10;

export function resumoEmTexto(r: ResultadoDoCenario): string {
  const linhas: string[] = [`# ${r.cenario}`, "", r.descricao, "", `Início: ${r.inicio}`, "", `> ${r.aviso}`, ""];
  if (r.degraus.length > 0) {
    linhas.push("| pedido (ordens/s) | enviado | 2xx | 429 | 5xx | outras recusas | POST p50 | POST p95 | POST p99 | em voo no fim |", "|---|---|---|---|---|---|---|---|---|---|");
    for (const d of r.degraus) {
      const post = d.latencia.ordem_limite ?? d.latencia.ordem_mercado;
      const recusas = Object.entries(d.status)
        .filter(([k]) => /^4\d\d$/.test(k) && k !== "429")
        .reduce((s, [, v]) => s + v, 0);
      linhas.push(
        `| ${d.pedidoPorSegundo} | ${d.enviadoPorSegundo} | ${d.status["2xx"] ?? 0} | ${d.status["429"] ?? 0} | ${d.status["5xx"] ?? 0} | ${recusas} | ${arred(post?.p50 ?? 0)} | ${arred(post?.p95 ?? 0)} | ${arred(post?.p99 ?? 0)} | ${d.emVoo} |`,
      );
    }
    linhas.push("");
  }
  if (r.servidor) {
    linhas.push("Travas medidas no servidor (ms):", "", "| trava | espera p50 | espera p95 | espera p99 | retenção p50 | retenção p95 | retenção p99 | n |", "|---|---|---|---|---|---|---|---|");
    for (const [nome, t] of [...Object.entries(r.servidor.travas), ...Object.entries(r.servidor.clubes).map(([k, v]) => [`clube ${k}`, v] as const)]) {
      linhas.push(`| ${nome} | ${t.espera.p50} | ${t.espera.p95} | ${t.espera.p99} | ${t.retencao.p50} | ${t.retencao.p95} | ${t.retencao.p99} | ${t.espera.n} |`);
    }
    const a = r.servidor.atrasoEventos;
    linhas.push("", `Atraso dos eventos (publicação até o envio ao socket, servidor): p50 ${a.p50} ms, p95 ${a.p95} ms, p99 ${a.p99} ms, máx ${a.max} ms (n=${a.n}).`);
    linhas.push(`Repetições por deadlock: ${r.servidor.repeticoes.total} (esgotadas: ${r.servidor.repeticoes.esgotadas}).`, "");
  }
  if (r.conexoes) {
    const c = r.conexoes;
    linhas.push(`Conexões: ${c.abertas} abertas, ${c.tentativas} tentativas, ${c.fechadasPeloServidor} fechadas pelo servidor, ${c.eventos} eventos recebidos, ${c.buracosDeSeq} buracos de seq.`);
    for (const [tipo, h] of Object.entries(c.atraso)) linhas.push(`- atraso de ${tipo} no cliente: p50 ${h.p50} ms, p95 ${h.p95} ms, p99 ${h.p99} ms (n=${h.n})`);
    linhas.push("");
  }
  if (r.memoria) linhas.push(`Memória: servidor ${r.memoria.servidorRssMb} MB, gerador ${r.memoria.geradorRssMb} MB.`, "");
  linhas.push(`Invariantes no fim: ${r.invariantes === "nao_rodou" ? "não rodou" : r.invariantes.ok ? "passaram" : `VIOLADAS: ${r.invariantes.violacoes.join("; ")}`}`, "");
  if (r.metas.length > 0) {
    linhas.push("| meta | valor medido | resultado |", "|---|---|---|");
    for (const m of r.metas) linhas.push(`| ${m.meta} | ${m.valor} | ${m.ok ? "ok" : "**fora**"} |`);
    linhas.push("");
  }
  if (r.extras) linhas.push("```json", JSON.stringify(r.extras, null, 2), "```", "");
  return linhas.join("\n");
}

/** Grava `<pasta>/<cenario>.json` e `.md`. */
export function gravarRelatorio(pasta: string, r: ResultadoDoCenario): string {
  mkdirSync(pasta, { recursive: true });
  const base = join(pasta, r.cenario);
  writeFileSync(`${base}.json`, JSON.stringify(r, null, 2));
  writeFileSync(`${base}.md`, resumoEmTexto(r));
  return base;
}
