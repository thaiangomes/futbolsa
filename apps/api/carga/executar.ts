/**
 * A execução da carga (T17), chamada por `npm run carga -w @futbolsa/api -- --escala pico --cenario todos`.
 * Opções: `--escala leve|pico|completa` (padrão leve), `--cenario pico|degraus|tesouraria|reconexao|leituras|bots|encerramento|todos`
 * (padrão pico), `--saida <pasta>` (padrão carga-saida), `--manter` (não apaga o banco). Precisa de TEST_DATABASE_URL (um Postgres local
 * ou o do CI): o banco da carga é criado ao lado e apagado no fim.
 *
 * Sobe o servidor da carga num processo separado (pelo vitest, que traz o SWC para o Nest), prepara a população por este processo
 * e roda os cenários, gravando um `.json` e um `.md` por cenário.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { criarBancoDoEnsaio } from "../ensaio/banco.js";
import { CENARIOS, ORDEM_DE_TODOS } from "./cenarios/index.js";
import { ESCALAS } from "./cenarios/escalas.js";
import { prepararCarga } from "./gerador.js";
import { AVISO_DE_AMBIENTE, gravarRelatorio, type ResultadoDoCenario } from "./relatorio.js";

const { values } = parseArgs({
  options: {
    escala: { type: "string", default: "leve" },
    cenario: { type: "string", default: "pico" },
    saida: { type: "string", default: "carga-saida" },
    manter: { type: "boolean", default: false },
  },
});

const escala = ESCALAS[values.escala as keyof typeof ESCALAS];
if (!escala) throw new Error(`escala desconhecida: ${values.escala} (leve, pico ou completa)`);
const nomes = values.cenario === "todos" ? [...ORDEM_DE_TODOS] : values.cenario!.split(",");
for (const n of nomes) if (!CENARIOS[n]) throw new Error(`cenário desconhecido: ${n} (${Object.keys(CENARIOS).join(", ")}, todos)`);
const urlBase = process.env.TEST_DATABASE_URL;
if (!urlBase) throw new Error("Defina TEST_DATABASE_URL (Postgres local).");

const log = (l: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${l}`);
const banco = await criarBancoDoEnsaio(urlBase);
const pasta = mkdtempSync(join(tmpdir(), "futbolsa-carga-"));
const prontoArquivo = join(pasta, "pronto.json");
let filho: ChildProcess | undefined;
let codigo = 0;

try {
  log(`banco ${banco.nome}; subindo o servidor da carga (processo separado)...`);
  const vitest = join(process.cwd(), "..", "..", "node_modules", "vitest", "vitest.mjs");
  filho = spawn(process.execPath, [vitest, "run", "--config", "vitest.carga.config.ts", "carga/servidor.carga.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, CARGA_DATABASE_URL: banco.url, CARGA_PRONTO: prontoArquivo, CARGA_POOL: "30" },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const limite = Date.now() + 120_000;
  while (!existsSync(prontoArquivo)) {
    if (filho.exitCode !== null) throw new Error("o servidor da carga terminou antes de ficar pronto");
    if (Date.now() > limite) throw new Error("o servidor da carga não ficou pronto em 120 s");
    await new Promise((r) => setTimeout(r, 250));
  }
  const { controleUrl } = JSON.parse(readFileSync(prontoArquivo, "utf8")) as { controleUrl: string };

  log(`preparando a carga (${escala.nome}): ${escala.jogadores} jogadores, ${escala.clubes} clubes`);
  const preparado = await prepararCarga({
    controleUrl,
    databaseUrl: banco.url,
    populacao: { clubes: escala.clubes, jogadores: escala.jogadores },
    log,
  });
  try {
    await preparado.controle.cenario("reposicao", { cadaMs: 5000 });
    for (const nome of nomes) {
      log(`== cenário ${nome} ==`);
      const resultado = await CENARIOS[nome]!(preparado, escala, log).catch((erro: Error): ResultadoDoCenario => {
        // um cenário que quebra não derruba os outros: o relatório dele mostra o erro
        log(`o cenário ${nome} falhou: ${erro.message}`);
        return { cenario: nome, descricao: "O cenário falhou antes de terminar.", inicio: new Date().toISOString(), configuracao: { escala: escala.nome }, degraus: [], invariantes: "nao_rodou", extras: { erro: erro.message }, metas: [{ meta: "o cenário termina sem erro", valor: erro.message.slice(0, 200), ok: false }], aviso: AVISO_DE_AMBIENTE };
      });
      const arquivo = gravarRelatorio(values.saida!, resultado);
      const fora = resultado.metas.filter((m) => !m.ok);
      log(`${nome}: ${resultado.metas.length - fora.length}/${resultado.metas.length} metas dentro; relatório em ${arquivo}.md`);
      for (const m of fora) log(`  fora da meta: ${m.meta} (${m.valor})`);
    }
  } finally {
    await preparado.fechar();
  }
} catch (erro) {
  console.error(erro);
  codigo = 1;
} finally {
  if (filho && filho.exitCode === null) {
    filho.kill();
    await new Promise((r) => setTimeout(r, 1500));
    if (filho.exitCode === null && process.platform === "win32" && filho.pid) spawn("taskkill", ["/pid", String(filho.pid), "/t", "/f"]);
  }
  rmSync(pasta, { recursive: true, force: true });
  if (!values.manter) await banco.apagar().catch((e) => console.error(`não apagou ${banco.nome}: ${(e as Error).message}`));
}
process.exit(codigo);
