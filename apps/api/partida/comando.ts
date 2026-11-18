/**
 * `npm run partida:relogio -- <comando>`: o relógio da partida pelo terminal, na porta de controle local (a mesma lógica da tela do
 * admin). Comandos: `estado`, `agora`, `dia`, `rodada`, `ate AAAA-MM-DD`, `atualizar`, `pausar`, `tempo-real`.
 */
import { PORTAS_DA_PARTIDA } from "./portas.js";

const base = process.env.PARTIDA_CONTROLE ?? `http://127.0.0.1:${PORTAS_DA_PARTIDA.controle}`;
const [acao, data] = process.argv.slice(2);
const validas = ["estado", "agora", "dia", "rodada", "ate", "atualizar", "pausar", "tempo-real"];
if (!acao || !validas.includes(acao) || (acao === "ate" && !data)) {
  console.error(`Uso: npm run partida:relogio -- <${validas.join("|")}> [AAAA-MM-DD]`);
  process.exit(1);
}
try {
  const res = await fetch(acao === "estado" ? `${base}/estado` : `${base}/relogio`, acao === "estado" ? undefined : { method: "POST", body: JSON.stringify(acao === "ate" ? { acao, data } : { acao }) });
  const corpo = (await res.json()) as { erro?: string; mensagem?: string; estado?: unknown };
  if (!res.ok) {
    console.error(`recusado (${res.status}): ${corpo.erro ?? JSON.stringify(corpo)}`);
    process.exit(2);
  }
  if (corpo.mensagem) console.log(corpo.mensagem);
  console.log(JSON.stringify(corpo.estado ?? corpo, null, 2));
} catch (erro) {
  console.error(`não consegui falar com a partida em ${base} (ela está ligada? npm run partida): ${(erro as Error).message}`);
  process.exit(3);
}
