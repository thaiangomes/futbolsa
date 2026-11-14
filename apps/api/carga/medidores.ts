import type { LockKind, Metrics } from "../src/infra/db/metrics.js";

/**
 * Histograma de precisão relativa de 1% (os baldes crescem em progressão geométrica): memória fixa mesmo com milhões de
 * amostras, e p50, p95 e p99 com erro de até 1%. Os valores são milissegundos.
 */
const RAZAO = 1.01;
const PISO = 0.001; // 1 µs: abaixo disso tudo cai no primeiro balde

export class Histograma {
  private readonly baldes = new Map<number, number>();
  private n = 0;
  private soma = 0;
  private maximo = 0;

  registrar(ms: number): void {
    const valor = Math.max(ms, 0);
    const balde = Math.floor(Math.log(Math.max(valor, PISO) / PISO) / Math.log(RAZAO));
    this.baldes.set(balde, (this.baldes.get(balde) ?? 0) + 1);
    this.n += 1;
    this.soma += valor;
    if (valor > this.maximo) this.maximo = valor;
  }

  /** O valor abaixo do qual ficam `p`% das amostras (0 a 100); 0 sem amostras. */
  percentil(p: number): number {
    if (this.n === 0) return 0;
    const alvo = Math.max(1, Math.ceil((p / 100) * this.n));
    let acumulado = 0;
    for (const balde of [...this.baldes.keys()].sort((a, b) => a - b)) {
      acumulado += this.baldes.get(balde)!;
      if (acumulado >= alvo) return Math.min(this.maximo, PISO * RAZAO ** (balde + 0.5));
    }
    return this.maximo;
  }

  resumo(): ResumoHistograma {
    const arredondar = (x: number) => Math.round(x * 1000) / 1000;
    return {
      n: this.n,
      media: arredondar(this.n === 0 ? 0 : this.soma / this.n),
      p50: arredondar(this.percentil(50)),
      p95: arredondar(this.percentil(95)),
      p99: arredondar(this.percentil(99)),
      max: arredondar(this.maximo),
    };
  }
}

export interface ResumoHistograma {
  n: number;
  media: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface RelatorioMedidas {
  /** Por tipo de trava (`club`, `wallet`, `wallet_treasury`...): espera pela trava e tempo com ela. */
  travas: Record<string, { espera: ResumoHistograma; retencao: ResumoHistograma }>;
  /** O mesmo por clube (só `club`, chave = ticker). */
  clubes: Record<string, { espera: ResumoHistograma; retencao: ResumoHistograma }>;
  repeticoes: { total: number; porCodigo: Record<string, number>; esgotadas: number };
  atrasoEventos: ResumoHistograma;
}

/**
 * Os medidores do servidor de carga: guardam histogramas em memória e entregam o relatório pela porta de controle
 * (`GET /medidas`). Só existem no processo do servidor de teste; a API de verdade usa o `NoopMetrics`.
 */
export class MedidoresHistograma implements Metrics {
  readonly enabled = true;
  private readonly espera = new Map<string, Histograma>();
  private readonly retencao = new Map<string, Histograma>();
  private readonly porCodigo = new Map<string, number>();
  private esgotadas = 0;
  private atraso = new Histograma();

  private h(mapa: Map<string, Histograma>, chave: string): Histograma {
    let h = mapa.get(chave);
    if (!h) mapa.set(chave, (h = new Histograma()));
    return h;
  }

  lockWait(kind: LockKind, key: string | undefined, ms: number): void {
    this.h(this.espera, kind).registrar(ms);
    // a chave do clube é o ticker (ou os tickers, separados por vírgula, quando a transação trava mais de um)
    if (kind === "club" && key) this.h(this.espera, `club:${key}`).registrar(ms);
  }

  lockHeld(kind: LockKind, key: string | undefined, ms: number): void {
    this.h(this.retencao, kind).registrar(ms);
    if (kind === "club" && key) this.h(this.retencao, `club:${key}`).registrar(ms);
  }

  retry(code: string): void {
    this.porCodigo.set(code, (this.porCodigo.get(code) ?? 0) + 1);
  }

  retryExhausted(): void {
    this.esgotadas += 1;
  }

  eventDelay(ms: number): void {
    this.atraso.registrar(ms);
  }

  reiniciar(): void {
    this.espera.clear();
    this.retencao.clear();
    this.porCodigo.clear();
    this.esgotadas = 0;
    this.atraso = new Histograma();
  }

  relatorio(): RelatorioMedidas {
    const vazio = new Histograma();
    const travas: RelatorioMedidas["travas"] = {};
    const clubes: RelatorioMedidas["clubes"] = {};
    const chaves = new Set([...this.espera.keys(), ...this.retencao.keys()]);
    for (const chave of [...chaves].sort()) {
      const par = { espera: (this.espera.get(chave) ?? vazio).resumo(), retencao: (this.retencao.get(chave) ?? vazio).resumo() };
      if (chave.startsWith("club:")) clubes[chave.slice(5)] = par;
      else travas[chave] = par;
    }
    const porCodigo = Object.fromEntries(this.porCodigo);
    return {
      travas,
      clubes,
      repeticoes: { total: [...this.porCodigo.values()].reduce((a, b) => a + b, 0), porCodigo, esgotadas: this.esgotadas },
      atrasoEventos: this.atraso.resumo(),
    };
  }
}
