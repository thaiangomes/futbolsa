import type { ChartMarker } from "./markers";

/** O balão de um marcador: título e linhas de detalhe. Sai do clique do gráfico (ou da lista de texto). */
export function MarkerBalloon({ marker, onClose }: { marker: ChartMarker; onClose: () => void }) {
  return (
    <div className="pop" role="dialog" aria-label={marker.title} data-testid="balao-marcador" style={{ top: 56, left: 16 }}>
      <div className="row between" style={{ flexWrap: "nowrap" }}>
        <b>{marker.title}</b>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Fechar">×</button>
      </div>
      {marker.lines.map((line) => (
        <div key={line} className="small muted">{line}</div>
      ))}
    </div>
  );
}
