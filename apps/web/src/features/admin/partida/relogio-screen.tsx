"use client";

import { useEffect, useState } from "react";
import { formatInstant } from "../../../lib/format";
import type { AdminApi } from "../api";
import { Card, ErrorNote, LoadState, useAction, useLoader } from "../ui";
import type { PedidoDoRelogio } from "./schemas";

/**
 * O relógio da partida de teste (F17, Partida de teste, D1): o instante do jogo, o limite dos dados, o salto (1 dia, até a
 * próxima rodada, até uma data), o tempo real e o "atualizar". Só aparece no modo partida; a API recusa quem não é admin.
 */
export function RelogioScreen({ admin }: { admin: AdminApi }) {
  const loader = useLoader(() => admin.partida());
  const action = useAction();
  // pausar tem o próprio estado: com um salto andando, o pedido do salto segura `action` e a pausa não pode esperar por ele
  const pausa = useAction();
  const [data, setData] = useState("");
  const [mensagem, setMensagem] = useState<string | null>(null);

  // o relógio anda sozinho no tempo real e as paradas mudam o instante: confere de 3 em 3 segundos
  useEffect(() => {
    const id = setInterval(() => void loader.reload(), 3000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const view = loader.data;
  if (!view) return <LoadState loader={loader} />;
  const r = view.relogio;

  const pedir = async (pedido: PedidoDoRelogio) => {
    setMensagem(null);
    await action.run(async () => {
      const resposta = await admin.partidaRelogio(pedido);
      setMensagem(resposta.mensagem);
    });
    await loader.reload();
  };
  const ocupado = action.busy || r.ocupado !== null;
  const pausar = async () => {
    setMensagem(null);
    await pausa.run(async () => {
      const resposta = await admin.partidaRelogio({ acao: "pausar" });
      setMensagem(resposta.mensagem);
    });
    await loader.reload();
  };
  // um salto andando (ou o tempo real) pode ser pausado; o "atualizar" não
  const podePausar = r.modo === "tempo-real" || (r.ocupado !== null && r.ocupado !== "atualizar");

  return (
    <div className="stack">
      <Card title="Agora no jogo" right={<span className={`chip${r.modo === "tempo-real" ? " chip-live" : ""}`}>{r.modo === "tempo-real" ? "Tempo real" : "Pausado"}</span>}>
        <p className="h2" data-testid="relogio-instante">{formatInstant(r.instante)}</p>
        {r.aguardando ? (
          <div className="note note-warn" role="status">
            <div>
              Aguardando resultados reais{r.ultimoResultado ? ` (último resultado em ${formatInstant(r.ultimoResultado)})` : ""}. Peça “Atualizar dados” quando houver jogos novos.
            </div>
          </div>
        ) : r.dadosFrescos ? (
          <p className="muted small" data-testid="relogio-fresco">
            Dados baixados há pouco ({r.baixadoEm ? formatInstant(r.baixadoEm) : "—"}): o relógio pode ir até a hora real. No tempo real, a partida baixa os dados sozinha a cada 5 minutos.
          </p>
        ) : (
          <p className="muted small">
            O relógio vai até {r.limite ? formatInstant(r.limite) : "—"} (fim do último jogo terminado nos dados{r.dadosDe ? `, baixados em ${formatInstant(r.dadosDe)}` : ""}).
          </p>
        )}
        {r.ocupado && <p className="muted small" role="status" data-testid="relogio-ocupado">O relógio está andando: {r.ocupado}…</p>}
      </Card>

      <Card title="Avançar o tempo">
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn btn-p" disabled={ocupado} data-testid="relogio-agora" onClick={() => void pedir({ acao: "agora" })}>Alcançar a hora real e ligar o tempo real</button>
          <button type="button" className="btn btn-p" disabled={ocupado || r.aguardando} onClick={() => void pedir({ acao: "dia" })}>1 dia</button>
          <button type="button" className="btn btn-p" disabled={ocupado || r.aguardando} onClick={() => void pedir({ acao: "rodada" })}>Até a próxima rodada</button>
        </div>
        <form
          className="row"
          style={{ gap: 8, marginTop: 12, alignItems: "flex-end" }}
          onSubmit={(e) => {
            e.preventDefault();
            if (data) void pedir({ acao: "ate", data });
          }}
        >
          <div className="field">
            <label htmlFor="relogio-data">Até a data (00:00 de Brasília)</label>
            <input id="relogio-data" className="input" type="date" value={data} onChange={(e) => setData(e.target.value)} />
          </div>
          <button type="submit" className="btn" disabled={ocupado || r.aguardando || !data}>Avançar até a data</button>
        </form>
        <p className="muted small" style={{ marginTop: 12 }}>
          Os saltos passam por todas as paradas do meio (jogos, fechamentos e bots) e levam de 1 a 3 minutos. Depois do salto o relógio volta ao estado em que estava.
        </p>
      </Card>

      <Card title="Ritmo e dados">
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {podePausar ? (
            <button type="button" className="btn" disabled={pausa.busy} onClick={() => void pausar()}>Pausar</button>
          ) : (
            <button type="button" className="btn" disabled={ocupado || r.aguardando} onClick={() => void pedir({ acao: "tempo-real" })}>Ligar o tempo real</button>
          )}
          <button type="button" className="btn" disabled={ocupado} onClick={() => void pedir({ acao: "atualizar" })}>Atualizar dados</button>
        </div>
        <p className="muted small" style={{ marginTop: 12 }}>
          “Atualizar dados” baixa de novo os jogos da ESPN e acrescenta a foto nova ao banco da partida. Com o relógio parado, os jogadores continuam lendo o mercado e mandando ordens.
        </p>
      </Card>

      {mensagem && (
        <div className="note" role="status">
          <div>{mensagem}</div>
        </div>
      )}
      <ErrorNote message={action.error} />
    </div>
  );
}
