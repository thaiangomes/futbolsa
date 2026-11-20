"use client";

import { useState } from "react";
import type { SeasonRulesView } from "@futbolsa/contracts";
import type { AdminApi } from "../api";
import { formatCents } from "../forms";
import { Card, ErrorNote, useAction } from "../ui";

const centsField = (v: string) => /^\d{1,9}$/.test(v);

/** Um campo em centavos com o valor em reais ao lado (ou a unidade, nos campos de quantidade). */
function NumberInput({ id, label, value, locked, onChange, unit }: { id: string; label: string; value: string; locked: boolean; onChange(v: string): void; unit?: string }) {
  const ok = centsField(value);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="row" style={{ alignItems: "center", gap: 8 }}>
        <input id={id} className={`input${ok ? "" : " err"}`} style={{ width: 110, textAlign: "right" }} inputMode="numeric" disabled={locked} value={value} onChange={(e) => onChange(e.target.value)} />
        <span className="xs muted num">{ok ? (unit ? unit : formatCents(Number(value))) : "—"}</span>
      </div>
    </div>
  );
}

/**
 * Valores das ligas (Dividendos e recompra): por ponto, colocação final da Série A, classificação para o ano seguinte
 * (Libertadores e Sul-Americana), penalização de rebaixamento e acesso. Em centavos por ação. Travam na abertura do IPO.
 */
export function LeaguesCard({ seasonId, rules, locked, admin, onDone }: { seasonId: number; rules: SeasonRulesView; locked: boolean; admin: AdminApi; onDone(): Promise<void> }) {
  const [aPerPoint, setAPerPoint] = useState(String(rules.aPerPoint));
  const [bPerPoint, setBPerPoint] = useState(String(rules.bPerPoint));
  const [placement, setPlacement] = useState(rules.aPlacement.map(String));
  const [lib, setLib] = useState(String(rules.aLibertadoresBonus));
  const [sul, setSul] = useState(String(rules.aSulamericanaBonus));
  const [penalty, setPenalty] = useState(String(rules.aRelegationPenalty));
  const [slots, setSlots] = useState(String(rules.aRelegationSlots));
  const [promotion, setPromotion] = useState(String(rules.promotionPerShare));
  const [promotionSlots, setPromotionSlots] = useState(String(rules.promotionSlots));
  const action = useAction();

  const all = [aPerPoint, bPerPoint, ...placement, lib, sul, penalty, slots, promotion, promotionSlots];
  const valid = all.every(centsField) && Number(slots) <= 20;
  const current = [rules.aPerPoint, rules.bPerPoint, ...rules.aPlacement, rules.aLibertadoresBonus, rules.aSulamericanaBonus, rules.aRelegationPenalty, rules.aRelegationSlots, rules.promotionPerShare, rules.promotionSlots].map(String);
  const edited = all.some((v, i) => v !== current[i]);

  const save = async () => {
    const body = {
      aPerPoint: Number(aPerPoint),
      bPerPoint: Number(bPerPoint),
      aPlacement: placement.map(Number),
      aLibertadoresBonus: Number(lib),
      aSulamericanaBonus: Number(sul),
      aRelegationPenalty: Number(penalty),
      aRelegationSlots: Number(slots),
      promotionPerShare: Number(promotion),
      promotionSlots: Number(promotionSlots),
      buybackMultipleBp: rules.buybackMultipleBp,
    };
    if (await action.run(() => admin.putRules(seasonId, body))) await onDone();
  };

  return (
    <Card title="Valores das ligas" right={locked ? <span className="chip chip-down">Travados</span> : <span className="chip chip-live">Editáveis até abrir o IPO</span>}>
      <div className="stack-s">
        <div className="row">
          <NumberInput id="a-por-ponto" label="Série A, por ponto" value={aPerPoint} locked={locked} onChange={setAPerPoint} />
          <NumberInput id="b-por-ponto" label="Série B, por ponto" value={bPerPoint} locked={locked} onChange={setBPerPoint} />
        </div>
        <div>
          <div className="small b">Colocação final da Série A (centavos por ação)</div>
          <div className="scroll-x">
            <table className="tbl">
              <thead><tr><th>Colocação</th><th className="r">Centavos por ação</th><th className="r">Em reais</th></tr></thead>
              <tbody>
                {placement.map((v, i) => (
                  <tr key={i}>
                    <td className="num">{i + 1}º</td>
                    <td className="r"><input aria-label={`Colocação ${i + 1}º`} className={`input${centsField(v) ? "" : " err"}`} style={{ width: 100, height: 32, textAlign: "right" }} inputMode="numeric" disabled={locked} value={v} onChange={(e) => setPlacement(placement.map((x, j) => (j === i ? e.target.value : x)))} /></td>
                    <td className="r num">{centsField(v) ? formatCents(Number(v)) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="row">
          <NumberInput id="bonus-libertadores" label="Classificação para a Libertadores (centavos por ação)" value={lib} locked={locked} onChange={setLib} />
          <NumberInput id="bonus-sulamericana" label="Classificação para a Sul-Americana (centavos por ação)" value={sul} locked={locked} onChange={setSul} />
        </div>
        <p className="xs muted m0">Quem se classifica nas duas recebe só o da Libertadores. O admin marca os classificados na tela da classificação oficial, no fechamento: o sistema não deduz.</p>
        <div className="row">
          <NumberInput id="penalizacao" label="Penalização de rebaixamento (centavos por ação)" value={penalty} locked={locked} onChange={setPenalty} />
          <NumberInput id="rebaixados" label="Quantos últimos colocados pagam" value={slots} locked={locked} onChange={setSlots} unit="rebaixados" />
        </div>
        <p className="xs muted m0">A penalização é debitada do caixa no fechamento, mesmo que o caixa fique negativo; fica fora da base da recompra.</p>
        <div className="row">
          <NumberInput id="acesso" label="Acesso à Série A (centavos por ação)" value={promotion} locked={locked} onChange={setPromotion} />
          <NumberInput id="vagas-acesso" label="Clubes que sobem" value={promotionSlots} locked={locked} onChange={setPromotionSlots} unit="clubes" />
        </div>
        <ErrorNote message={action.error} />
        <button type="button" className="btn btn-p btn-sm" disabled={locked || !edited || !valid || action.busy} onClick={() => void save()}>Salvar os valores</button>
        <p className="xs muted" style={{ marginBottom: 0 }}>Os valores vêm da temporada anterior (ou das constantes do jogo) e travam na abertura do IPO.</p>
      </div>
    </Card>
  );
}
