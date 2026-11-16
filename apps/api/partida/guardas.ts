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

/** Endereço IPv4 de rede privada: 10.x, 172.16 a 31.x ou 192.168.x (nunca 0.0.0.0, nem público, nem nome). */
export function ehEnderecoPrivado(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number) as [number, number, number, number];
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * A partida só escuta no endereço local. Com a opção explícita de rede privada (`redePrivada`, desligada por padrão), aceita
 * também um endereço de rede privada, e só ele: nunca 0.0.0.0 nem endereço público.
 */
export function recusarEscutaForaDoLocal(host: string, redePrivada = false): void {
  if (["127.0.0.1", "::1", "localhost"].includes(host)) return;
  if (redePrivada && ehEnderecoPrivado(host)) return;
  throw new Error(
    redePrivada
      ? `A partida só escuta em 127.0.0.1 ou num endereço de rede privada (192.168.x, 10.x, 172.16 a 31.x), não em ${host}.`
      : `A partida só escuta em 127.0.0.1, não em ${host}.`,
  );
}

/** Todas as guardas de uma vez, antes de qualquer coisa subir. */
export function recusarAmbienteDaPartida(o: { urlBanco: string; host?: string; redePrivada?: boolean; env?: NodeJS.ProcessEnv }): void {
  recusarProducao(o.env);
  recusarBancoNaoLocalEstrito(o.urlBanco);
  recusarEscutaForaDoLocal(o.host ?? "127.0.0.1", o.redePrivada);
}
