import { recusarBancoNaoLocal, recusarProducao } from "../ensaio/guardas.js";

/**
 * Guardas da partida de teste (F17, critério 14): a partida nunca nasce com `NODE_ENV=production`, só liga num Postgres da
 * própria máquina e só escuta em 127.0.0.1 (a etapa 1 é só do Thaian; a etapa 2 publica a API por um túnel que chega a esta
 * mesma escuta local). As mensagens nunca levam senha: só o nome do host.
 */

export { recusarProducao };

/** Mais estrita que a do ensaio: nada de serviço de contêiner, só `localhost`, `127.0.0.1` e `::1`. */
export function recusarBancoNaoLocalEstrito(url: string): void {
  recusarBancoNaoLocal(url);
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error(`A partida só liga em banco da própria máquina (localhost ou 127.0.0.1), não em ${host}.`);
  }
}

/** A partida só escuta no endereço local. */
export function recusarEscutaForaDoLocal(host: string): void {
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error(`A partida só escuta em 127.0.0.1, não em ${host}.`);
  }
}

/** Todas as guardas de uma vez, antes de qualquer coisa subir. */
export function recusarAmbienteDaPartida(o: { urlBanco: string; host?: string; env?: NodeJS.ProcessEnv }): void {
  recusarProducao(o.env);
  recusarBancoNaoLocalEstrito(o.urlBanco);
  recusarEscutaForaDoLocal(o.host ?? "127.0.0.1");
}
