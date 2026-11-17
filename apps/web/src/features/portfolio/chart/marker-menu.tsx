"use client";

import { useEffect, useId, useState } from "react";
import { competitionName } from "../../club-games";
import { useIsNarrow } from "../../market/mobile-club";
import { setMarkerPrefs, useMarkerPrefs } from "./marker-prefs";

/**
 * O botão "Marcadores" do gráfico (Carteira e gráficos, critérios 46 e 47): liga e desliga os dividendos, as minhas
 * negociações e os jogos (e, dentro deles, cada competição que tem jogo no período). A escolha vale para todos os
 * gráficos e fica salva no navegador. No computador abre um painel junto do botão; no celular, uma folha. No gráfico de
 * patrimônio da Carteira (`only="payout"`) só há dividendos.
 */
export function MarkerMenu({ competitions = [], showTrades = true, only }: { competitions?: readonly string[]; showTrades?: boolean; only?: "payout" }) {
  const [open, setOpen] = useState(false);
  const [prefs] = useMarkerPrefs();
  const narrow = useIsNarrow();
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const toggleCompetition = (competition: string) =>
    setMarkerPrefs({
      hiddenCompetitions: prefs.hiddenCompetitions.includes(competition)
        ? prefs.hiddenCompetitions.filter((c) => c !== competition)
        : [...prefs.hiddenCompetitions, competition],
    });

  const options = (
    <div className="stack-s" data-testid="marcadores-opcoes" style={{ gap: 8, minWidth: 220 }}>
      <label className="row-s" style={{ gap: 8 }}>
        <input type="checkbox" checked={prefs.payout} onChange={(e) => setMarkerPrefs({ payout: e.target.checked })} />
        <span>Dividendos</span>
      </label>
      {only !== "payout" && showTrades && (
        <label className="row-s" style={{ gap: 8 }}>
          <input type="checkbox" checked={prefs.trade} onChange={(e) => setMarkerPrefs({ trade: e.target.checked })} />
          <span>Minhas negociações</span>
        </label>
      )}
      {only !== "payout" && (
        <>
          <label className="row-s" style={{ gap: 8 }}>
            <input type="checkbox" checked={prefs.game} onChange={(e) => setMarkerPrefs({ game: e.target.checked })} />
            <span>Jogos</span>
          </label>
          {competitions.length > 0 && (
            <div className="stack-s" style={{ gap: 6, paddingLeft: 24 }} role="group" aria-label="Competições dos jogos">
              {competitions.map((c) => (
                <label key={c} className="row-s" style={{ gap: 8, opacity: prefs.game ? 1 : 0.5 }}>
                  <input type="checkbox" checked={!prefs.hiddenCompetitions.includes(c)} disabled={!prefs.game} onChange={() => toggleCompetition(c)} />
                  <span>{competitionName(c as Parameters<typeof competitionName>[0])}</span>
                </label>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );

  return (
    <div style={{ position: "relative" }}>
      <button type="button" className="btn btn-sm" data-testid="botao-marcadores" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)}>
        Marcadores
      </button>
      {open && !narrow && (
        <div id={panelId} className="card" role="group" aria-label="Marcadores do gráfico" data-testid="painel-marcadores" style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 5, padding: 12 }}>
          {options}
        </div>
      )}
      {open && narrow && (
        <>
          <div className="scrim" onClick={() => setOpen(false)} />
          <div id={panelId} className="sheet" role="dialog" aria-modal="true" aria-label="Marcadores do gráfico" data-testid="folha-marcadores" style={{ paddingLeft: 16, paddingRight: 16 }}>
            <div className="grab" />
            <div className="row between" style={{ marginBottom: 8 }}>
              <span className="h2">Marcadores</span>
              <button type="button" className="btn btn-ghost btn-sm" aria-label="Fechar" onClick={() => setOpen(false)}>×</button>
            </div>
            {options}
          </div>
        </>
      )}
    </div>
  );
}
