"use client";

import type { ClubValueView } from "@futbolsa/contracts";
import { buybackIfEndedNow, type ClubValueSimulation } from "@futbolsa/engine/engine/clubValue";
import { useEffect, useMemo, useState } from "react";
import { formatCents } from "../../lib/format";
import { SituationCard } from "./situation-card";
import {
  type BetForm,
  CUP_NAMES,
  cupOptions,
  cupStateText,
  formatBp,
  initialForm,
  MAX_POINTS,
  POSITIONS,
  simulate,
} from "./model";

/** Só o que o cartão pede da API (o `MarketApi` inteiro também serve). */
export interface ClubValueApi {
  dividends(ticker: string): Promise<ClubValueView>;
}

/** Lê o que o cartão precisa uma vez ao abrir: pago, a receber, pontos e fases das copas mudam a cada rodada, não a cada negócio. */
export function useClubValue(api: ClubValueApi, ticker: string): { view: ClubValueView | null; status: "loading" | "ready" | "error" } {
  const [state, setState] = useState<{ view: ClubValueView | null; status: "loading" | "ready" | "error" }>({ view: null, status: "loading" });
  useEffect(() => {
    let alive = true;
    setState({ view: null, status: "loading" });
    Promise.resolve()
      .then(() => api.dividends(ticker))
      .then(
        (view) => alive && setState({ view, status: "ready" }),
        () => alive && setState({ view: null, status: "error" }),
      );
    return () => {
      alive = false;
    };
  }, [api, ticker]);
  return state;
}

/**
 * "Quanto vale o FLA3 para você?" (prancha 1 e aba Sobre do celular; critério 38 do livro): o que a ação já pagou, o a receber
 * e a recompra se a temporada acabasse agora; embaixo, o simulador, em que o jogador aposta os pontos do clube no fim do
 * Brasileirão, a colocação final e até onde ele vai em cada copa, e vê os dividendos que faltam, a recompra e o valor por ação
 * na conta dele comparado com o preço. Usa só os valores fixos da temporada e o que o jogador informou: nunca o valor justo da casa.
 */
export function ClubValueCard({ ticker, name, price, api }: { ticker: string; name?: string; price: number; api: ClubValueApi }) {
  const { view, status } = useClubValue(api, ticker);
  const title = `Quanto vale o ${ticker} para você?`;
  if (!view) {
    return (
      <section className="card" aria-labelledby="t-valor" data-testid="valor-cartao">
        <div className="card-h"><h2 className="card-t" id="t-valor">{title}</h2></div>
        <div className="card-b">
          <p className="muted m0">{status === "error" ? "Não foi possível carregar os dividendos agora. Tente de novo em instantes." : "Carregando…"}</p>
        </div>
      </section>
    );
  }
  return (
    <>
      <SituationCard view={view} />
      <Loaded view={view} name={name ?? ticker} price={price} title={title} />
    </>
  );
}

function Loaded({ view, name, price, title }: { view: ClubValueView; name: string; price: number; title: string }) {
  const [form, setForm] = useState<BetForm>(() => initialForm(view));
  const sim = useMemo(() => simulate(view, price, form), [view, price, form]);
  const buybackNow = buybackIfEndedNow(view.paid, view.toReceive, view.buybackMultipleBp);
  const multiple = (view.buybackMultipleBp / 10_000).toLocaleString("pt-BR");
  const leagueName = view.league === "brasileirao-a" ? "Brasileirão" : "Série B";
  const set = (patch: Partial<BetForm>) => setForm((f) => ({ ...f, ...patch }));
  const pointsOk = sim.ok || !/pontos/.test(sim.message);

  return (
    <section className="card" aria-labelledby="t-valor" data-testid="valor-cartao">
      <div className="card-h">
        <h2 className="card-t" id="t-valor">{title}</h2>
        <span className="xs muted">A sua conta, com as suas apostas. Não é o valor justo da casa.</span>
      </div>
      <div className="card-b stack">
        <div className="g-kpi">
          <div className="kpi" data-testid="valor-pago"><span className="kpi-l">Dividendos pagos na temporada</span><span className="kpi-v">{formatCents(view.paid)}</span><span className="xs muted">por ação</span></div>
          <div className="kpi" data-testid="valor-a-receber"><span className="kpi-l">A receber</span><span className="kpi-v divc">{formatCents(view.toReceive)}</span><span className="xs muted">já fechado, aguardando aprovação</span></div>
          <div className="kpi" data-testid="valor-recompra-hoje"><span className="kpi-l">Recompra se acabasse hoje</span><span className="kpi-v">{formatCents(buybackNow)}</span><span className="xs muted">{multiple} × {formatCents(view.paid + view.toReceive)} pagos e a receber</span></div>
          <div className="kpi" data-testid="valor-pontos"><span className="kpi-l">{leagueName} até agora</span><span className="kpi-v">{view.points} {view.points === 1 ? "ponto" : "pontos"}</span><span className="xs muted">{view.position ? `${view.position}º lugar · ` : ""}{formatCents(view.leagueRules.perPoint)} por ponto</span></div>
        </div>

        <div className="g-2" style={{ gap: 24 }}>
          <div className="stack" style={{ gap: 12 }}>
            <span className="lbl">O que você acha que vai acontecer até o fim da temporada?</span>
            {view.leagueOpen ? (
              <>
                <div className="field">
                  <label htmlFor="sim-pontos">Pontos do {name} no fim do {leagueName}</label>
                  <input id="sim-pontos" className={`input${pointsOk ? "" : " err"}`} inputMode="numeric" value={form.points} onChange={(e) => set({ points: e.target.value })} />
                  <span className={`hint${pointsOk ? "" : " err"}`}>{pointsOk ? `Hoje: ${view.points} ${view.points === 1 ? "ponto" : "pontos"}.` : `Use um número inteiro de ${view.points} a ${MAX_POINTS}.`}</span>
                </div>
                <div className="field">
                  <label htmlFor="sim-colocacao">Colocação final</label>
                  <select id="sim-colocacao" className="input" value={form.position} onChange={(e) => set({ position: e.target.value })}>
                    {Array.from({ length: POSITIONS }, (_, i) => (
                      <option key={i + 1} value={String(i + 1)}>{i + 1}º lugar · {formatCents(view.leagueRules.placement[i] ?? 0)}</option>
                    ))}
                  </select>
                </div>
              </>
            ) : (
              <span className="xs muted">O {leagueName} já acabou: os pontos e a colocação já foram pagos.</span>
            )}
            {view.cups.map((cup) => {
              const id = `sim-copa-${cup.competition}`;
              const options = cupOptions(cup);
              const cupName = CUP_NAMES[cup.competition] ?? cup.competition;
              return options.length === 0 ? (
                <span key={cup.competition} className="xs muted">{cupName}: {cupStateText(cup)}, ela não paga mais nada.</span>
              ) : (
                <div key={cup.competition} className="field">
                  <label htmlFor={id}>{cupName} ({cupStateText(cup)})</label>
                  <select id={id} className="input" value={form.cups[cup.competition] ?? ""} onChange={(e) => set({ cups: { ...form.cups, [cup.competition]: e.target.value } })}>
                    {options.map((o) => (
                      <option key={o.value} value={o.value}>{o.label} · +{formatCents(o.extra)}</option>
                    ))}
                  </select>
                </div>
              );
            })}
            {view.cups.length === 0 && <span className="xs muted">{name} não joga copa nesta temporada.</span>}
          </div>

          <div className="stack" style={{ gap: 10 }}>
            <span className="lbl">Sua conta, por ação</span>
            {sim.ok && sim.result.simulation ? (
              <Account view={view} sim={sim.result.simulation} price={price} multiple={multiple} />
            ) : (
              <div className="note note-err" role="alert" data-testid="sim-erro"><div>{sim.ok ? "Preencha a aposta." : sim.message}</div></div>
            )}
            <span className="xs muted">
              Conta simplificada: não desconta o tempo até cada pagamento nem o risco de errar. Os valores por ponto, colocação, fase e o múltiplo da
              recompra são os da temporada e não mudam até o encerramento.
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

function Account({ view, sim, price, multiple }: { view: ClubValueView; sim: NonNullable<ReturnType<typeof simulate> extends infer S ? S extends { ok: true; result: infer R } ? R extends { simulation: infer M } ? M : never : never : never>; price: number; multiple: string }) {
  const { missing } = sim;
  const lines: Array<[string, number]> = [];
  if (view.leagueOpen) {
    lines.push([`Pontos que faltam pagar`, missing.points], [`Colocação final`, missing.placement]);
  }
  for (const cup of view.cups) if (cup.currentPhase !== null) lines.push([CUP_NAMES[cup.competition] ?? cup.competition, missing.cups[cup.competition] ?? 0]);
  lines.push(["A receber (já fechado)", missing.toReceive]);
  const gap = sim.priceGapBp;
  return (
    <>
      <div className="stack-s" style={{ gap: 0 }} data-testid="sim-conta">
        {lines.map(([label, cents]) => (
          <div key={label} className="kv"><span>{label}</span><span>{formatCents(cents)}</span></div>
        ))}
        <div className="kv" style={{ borderTop: "1px solid var(--line)", marginTop: 4, paddingTop: 8 }}><span>Dividendos que faltam</span><span data-testid="sim-faltam">{formatCents(missing.total)}</span></div>
        <div className="kv"><span>Dividendos da temporada na sua conta</span><span data-testid="sim-total">{formatCents(sim.seasonTotal)}</span></div>
        <div className="kv"><span>Recompra no fim ({multiple} × dividendos)</span><span data-testid="sim-recompra">{formatCents(sim.buyback)}</span></div>
      </div>
      <div className="card card-b stack-s" style={{ gap: 4, background: "var(--panel2)" }}>
        <span className="kpi-l">Valor por ação para você (dividendos que faltam + recompra)</span>
        <span className="disp num" style={{ fontSize: 38, fontWeight: 700, lineHeight: 1 }} data-testid="sim-valor">{formatCents(sim.value)}</span>
        {gap === null ? (
          <span className="small b muted" data-testid="sim-comparacao">Sem dividendos na conta, não há comparação com o preço.</span>
        ) : (
          <span className={`small b ${gap >= 0 ? "down" : "up"}`} data-testid="sim-comparacao">
            O preço agora ({formatCents(price)}) está {formatBp(gap)}% {gap >= 0 ? "acima" : "abaixo"} da sua conta.
          </span>
        )}
      </div>
    </>
  );
}
