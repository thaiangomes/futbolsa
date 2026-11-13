"use client";

import { useState } from "react";
import { formatMoney } from "../portfolio/format";
import type { AdminApi } from "./api";
import { Card, ErrorNote, LoadState, useAction, useLoader } from "./ui";

/**
 * Encerrar a temporada (Admin, critérios 21, 22 e 38): a lista do que falta com o link de cada pendência, o resumo do que
 * vai acontecer e a confirmação digitando o ano. Não tem volta: depois do encerramento nada mais muda na temporada.
 */
export function SeasonCloseScreen({ admin }: { admin: AdminApi }) {
  const loader = useLoader(async () => {
    const { season } = await admin.currentSeason();
    return season ? admin.seasonClose(season.id) : null;
  });
  const action = useAction();
  const [year, setYear] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const preview = loader.data;
  if (preview === undefined || preview === null) {
    return preview === null ? <div className="note" role="status"><div>Não há temporada em andamento para encerrar.</div></div> : <LoadState loader={loader} />;
  }

  const yearOk = year.trim() === String(preview.year);
  const close = async () => {
    let result: { wallets: number; results: number } | null = null;
    const ok = await action.run(async () => {
      result = await admin.closeSeason(preview.seasonId, Number(year));
    });
    if (ok && result) {
      setDone(`Temporada ${preview.year} encerrada. ${(result as { wallets: number; results: number }).wallets} carteiras foram a R$ 0,00 e ${(result as { wallets: number; results: number }).results} resultados entraram no histórico.`);
      await loader.reload();
    }
  };

  if (done) return <div className="note" role="status" data-testid="encerrada"><div>{done}</div></div>;
  return (
    <div className="stack">
      <Card title={`Temporada ${preview.year}`}>
        {preview.blockers.length === 0 ? (
          <p className="m0" data-testid="nada-falta">Nada falta: a temporada pode ser encerrada.</p>
        ) : (
          <ul className="stack-s" style={{ margin: 0 }} data-testid="o-que-falta">
            {preview.blockers.map((b) => (
              <li key={b.code} data-code={b.code}>
                {b.text}
                {b.link && <> · <a href={b.link}>resolver</a></>}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="O que vai acontecer">
        <ul className="stack-s" style={{ margin: 0 }}>
          <li>{preview.summary.wallets} carteiras (jogadores, bots e tesouraria) vão a R$ 0,00; o caixa que some soma {formatMoney(preview.summary.totalCash)}.</li>
          <li>O ranking do mês em curso e o anual ficam oficiais agora.</li>
          <li>{preview.summary.leader ? `O 1º do anual hoje é ${preview.summary.leader.nickname}, com ${formatMoney(preview.summary.leader.equity)}.` : "Ainda não há 1º colocado no anual."}</li>
        </ul>
      </Card>
      <Card title="Confirmar">
        <form className="stack-s" onSubmit={(e) => { e.preventDefault(); if (yearOk && preview.canClose) void close(); }}>
          <div className="note note-err"><div>Não tem volta. Depois do encerramento nenhuma correção, aprovação ou ajuste muda esta temporada.</div></div>
          <div className="field">
            <label htmlFor="ano">Digite o ano da temporada ({preview.year}) para confirmar</label>
            <input id="ano" className="input" inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value)} />
          </div>
          <ErrorNote message={action.error} />
          <button type="submit" className="btn btn-p" disabled={!preview.canClose || !yearOk || action.busy}>Encerrar a temporada</button>
        </form>
      </Card>
    </div>
  );
}
