/**
 * O processo do servidor da partida, subido por `npm run partida` (via `partida/iniciar.ts`, que traduz as opções para estas
 * variáveis). Roda pelo vitest só para ter o SWC (metadados de decorador do Nest). Fica de pé até o processo ser encerrado.
 * Variáveis: TEST_DATABASE_URL (Postgres local; a senha nunca vai para arquivo commitado), PARTIDA_SITE (pasta do site),
 * PARTIDA_ESCALA, PARTIDA_APELIDO, PARTIDA_APROVAR_SOZINHO, PARTIDA_PORTA_API, PARTIDA_PORTA_SITE, PARTIDA_PORTA_CONTROLE.
 */
import { resolve } from "node:path";
import { it } from "vitest";
import { subirPartida } from "./partida.js";
import { PORTAS_DA_PARTIDA } from "./portas.js";

it("servidor da partida", async () => {
  const urlBanco = process.env.TEST_DATABASE_URL;
  if (!urlBanco) throw new Error("Defina TEST_DATABASE_URL (Postgres local): a partida cria o banco futbolsa_partida nele.");
  const partida = await subirPartida({
    urlBanco,
    pastaDoSite: resolve(process.env.PARTIDA_SITE ?? "../web/out-partida"),
    escala: process.env.PARTIDA_ESCALA ? Number(process.env.PARTIDA_ESCALA.replace(",", ".")) : undefined,
    apelido: process.env.PARTIDA_APELIDO,
    aprovarSozinho: process.env.PARTIDA_APROVAR_SOZINHO === "1",
    portaApi: Number(process.env.PARTIDA_PORTA_API ?? PORTAS_DA_PARTIDA.api),
    portaSite: Number(process.env.PARTIDA_PORTA_SITE ?? PORTAS_DA_PARTIDA.site),
    portaControle: Number(process.env.PARTIDA_PORTA_CONTROLE ?? PORTAS_DA_PARTIDA.controle),
    laco: true,
  });
  const e = partida.relogio.estado();
  console.log(`\nPARTIDA PRONTA (${partida.nova ? "nova" : "retomada"}) em ${e.instante}, relógio ${e.modo}.`);
  console.log(`Site:      ${partida.siteUrl}   (entrar: ${partida.siteUrl}/entrar/jogador  ou  /entrar/admin)`);
  console.log(`Terminal:  npm run partida:relogio -- dia | rodada | ate AAAA-MM-DD | atualizar | pausar | tempo-real | estado`);
  await new Promise(() => undefined);
}, 0);
