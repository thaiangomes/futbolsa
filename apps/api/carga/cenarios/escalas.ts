/**
 * Os tamanhos de cada execução (T17). `leve` e `pico` rodam no computador de 8 GB; `completa` só no CI (`carga.yml`).
 * Os números de tempo desta máquina não dimensionam o servidor de verdade: servem para comparar execuções e achar gargalos.
 */
export interface Escala {
  nome: "leve" | "pico" | "completa";
  jogadores: number;
  clubes: number;
  conexoes: number;
  /** (a) o pico da meta. */
  ordensPorSegundo: number;
  segundosDoPico: number;
  /** (b) os degraus do limite por clube. */
  degraus: number[];
  segundosPorDegrau: number;
  /** (e) negócios de histórico (cada um com duas ordens) e linhas de extrato. */
  negociosDeHistorico: number;
  linhasDeExtrato: number;
  /** (f) bots por perfil (200 por perfil = o limite proposto da F14 de 1.800 bots; 22 por perfil ≈ 200 no total). */
  botsPorPerfil: number;
  /** (d) conexões da reconexão em massa. */
  conexoesDaQueda: number;
}

export const ESCALAS: Record<Escala["nome"], Escala> = {
  leve: {
    nome: "leve",
    jogadores: 150,
    clubes: 20,
    conexoes: 200,
    ordensPorSegundo: 20,
    segundosDoPico: 60,
    degraus: [20, 50, 100],
    segundosPorDegrau: 15,
    negociosDeHistorico: 50_000,
    linhasDeExtrato: 100_000,
    botsPorPerfil: 2,
    conexoesDaQueda: 200,
  },
  pico: {
    nome: "pico",
    jogadores: 600,
    clubes: 20,
    conexoes: 2000,
    ordensPorSegundo: 100,
    segundosDoPico: 60,
    degraus: [20, 50, 100, 200, 400],
    segundosPorDegrau: 20,
    negociosDeHistorico: 500_000,
    linhasDeExtrato: 1_000_000,
    botsPorPerfil: 22,
    conexoesDaQueda: 2000,
  },
  completa: {
    nome: "completa",
    jogadores: 10_000,
    clubes: 20,
    conexoes: 10_000,
    ordensPorSegundo: 100,
    segundosDoPico: 300,
    degraus: [20, 50, 100, 200, 400],
    segundosPorDegrau: 60,
    negociosDeHistorico: 15_000_000,
    linhasDeExtrato: 30_000_000,
    botsPorPerfil: 200,
    conexoesDaQueda: 10_000,
  },
};
