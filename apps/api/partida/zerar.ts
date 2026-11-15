/**
 * `npm run partida:zerar -- --sim`: apaga o banco `futbolsa_partida` (contas, carteiras, bots, relógio e as fotos dos dados) e a
 * próxima subida recomeça na abertura do IPO. Só pelo terminal, com a partida desligada; nunca pela tela do admin.
 */
import { apagarBanco, NOME_DO_BANCO } from "./banco.js";
import { recusarProducao } from "./guardas.js";

recusarProducao();
const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.error("Defina TEST_DATABASE_URL (Postgres local).");
  process.exit(1);
}
if (!process.argv.includes("--sim")) {
  console.error(`Isto apaga o banco ${NOME_DO_BANCO} inteiro (contas, carteiras, bots e o relógio). Confirme com: npm run partida:zerar -- --sim`);
  process.exit(1);
}
try {
  await apagarBanco(url);
  console.log(`Banco ${NOME_DO_BANCO} apagado. A próxima subida recomeça na abertura do IPO.`);
} catch (erro) {
  console.error(`não consegui zerar: ${(erro as Error).message}`);
  process.exit(2);
}
