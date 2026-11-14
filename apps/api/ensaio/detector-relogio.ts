import { sql } from "drizzle-orm";
import type { Database, DrizzleTx } from "../src/infra/db/index.js";

/**
 * Detector de relógio real (T8 do Plano do ensaio): o ensaio vive no relógio simulado (`FixedClock`); um `now()` do banco ou um
 * `new Date()` que escapou do `Clock` grava o instante de verdade (novembro de 2026, quando foi escrito) numa coluna
 * `timestamptz`, e isso estraga a ordem do tempo (desempate do rateio, ordens do mesmo instante, fechamento do mês). O detector
 * varre **todas** as colunas `timestamptz` do esquema `futbolsa` (pelo `information_schema`, então coluna nova entra sozinha) e
 * acusa:
 *
 * 1. valor **depois** do relógio simulado + 1 dia (a folga cobre o leilão e a tarefa que roda minutos depois), salvo nas colunas
 *    que guardam datas agendadas (`FUTURAS_PERMITIDAS`);
 * 2. valor no **dia de hoje real** (± 1 dia de `Date.now()`), quando o relógio simulado está a mais de 30 dias dele: assim o
 *    vazamento aparece mesmo num ensaio cujo relógio simulado esteja à frente do real;
 * 3. valor de antes de 1º de janeiro do ano anterior ao do ensaio (um `new Date(0)` ou uma data de outra temporada).
 *
 * Só lê (`SELECT`); nunca grava.
 */

const DIA = 24 * 3_600_000;
/** Distância mínima entre o relógio simulado e o real para a regra do "dia de hoje real" valer. */
const DISTANCIA_MINIMA_DO_REAL = 30 * DIA;

/**
 * Colunas que guardam o **futuro** de propósito (datas agendadas). Nelas a regra 1 não vale; as regras 2 e 3 continuam.
 * Cada uma, com o motivo (lido no esquema em `src/infra/db/schema`):
 */
export const FUTURAS_PERMITIDAS: Readonly<Record<string, string>> = {
  // O carregador grava o primeiro jogo (`PATCH /admin/seasons`) dias antes de o relógio chegar lá.
  "seasons.first_kickoff": "data do primeiro jogo, conhecida antes da temporada",
  // `ipoDates` calcula as três datas do IPO a partir do primeiro jogo, todas no futuro quando o admin confirma a temporada.
  "seasons.ipo_opens_at": "abertura agendada do IPO",
  "seasons.ipo_closes_at": "fechamento agendado do IPO",
  "seasons.trading_opens_at": "abertura agendada da negociação",
  // O calendário importado traz todos os jogos da temporada, com o início marcado meses à frente (e os adiados mais ainda).
  "matches.kickoff": "início marcado dos jogos do calendário",
};
// Fora da lista, de propósito: `season_clubs.auction_until` (o leilão dura minutos, dentro da folga de 1 dia),
// `season_clubs.tunnel_ref_day` (0h de hoje), `matches.finished_at` (a fonte de reprodução só revela o jogo depois do fim),
// `payout_events.closed_at`, `ranking_recalc_requests.from_at`, `fraud_cases.period_to` (sempre no passado).

/**
 * Vazamentos **conhecidos** do relógio real, achados pelo próprio detector na primeira execução (T8, 2026-11-13): colunas de
 * registro (`DEFAULT now()` do banco) que nenhuma regra do jogo lê para decidir nada. Ficam fora da conta por padrão para o
 * ensaio não parar neles, e `estrito: true` os acusa de novo. Cada um é um defeito a corrigir na fase dona (P11 do plano):
 * passar o `Clock` no `insert`. Quando for corrigido, sai daqui.
 */
export const RELOGIO_REAL_CONHECIDO: Readonly<Record<string, string>> = {
  // `BotsService` (src/modules/admin/bots/bots.service.ts) cria o bot sem `createdAt`; nada lê a coluna.
  "bots.created_at": "BotsService.insert(bots) sem createdAt (registro, sem regra)",
  // `SeasonsService.create` (src/modules/admin/seasons/seasons.service.ts) cria a temporada sem `createdAt`; nada lê a coluna.
  "seasons.created_at": "SeasonsService.create sem createdAt (registro, sem regra)",
  // `createAccount` de test/support/accounts.ts (usado por ensaio/contas.ts) cria o usuário e a identidade sem `createdAt`. A API
  // de verdade (`AccountsService`) passa o relógio. `users.created_at` só ordena a abertura das carteiras na virada da temporada
  // (`season-start.ts`), e o ensaio cria as contas antes dela.
  "users.created_at": "createAccount do suporte de testes sem createdAt (a API passa o Clock)",
  "auth_identities.created_at": "createAccount do suporte de testes sem createdAt (a API passa o Clock)",
  // `MatchesService.patch` (src/modules/admin/results/matches.service.ts) grava `updatedAt: new Date()` do relógio real ao editar um jogo.
  // Achado pela edição do placar à mão no ensaio (Admin 6); nada lê a coluna.
  "matches.updated_at": "MatchesService.patch grava new() Date do relógio real (registro, sem regra)",
};

export interface AchadoRelogio {
  tabela: string;
  coluna: string;
  regra: "depois_do_relogio_simulado" | "dia_de_hoje_real" | "antes_do_ano_do_ensaio";
  quantos: number;
  /** O valor mais suspeito (o maior, ou o mais perto de hoje real), em ISO. */
  exemplo: string;
}

export interface OpcoesDetector {
  /** O instante de verdade (padrão `Date.now()`); os testes passam um fixo. */
  agoraReal?: Date;
  /** Colunas a mais (`tabela.coluna`) que podem ter o futuro, com o motivo. */
  futurasPermitidas?: Readonly<Record<string, string>>;
  /** Acusa também os vazamentos conhecidos (`RELOGIO_REAL_CONHECIDO`). */
  estrito?: boolean;
}

type Leitor = Database | DrizzleTx;

/** As colunas `timestamptz` do esquema `futbolsa`, em ordem. */
export async function colunasTimestamptz(db: Leitor): Promise<Array<{ tabela: string; coluna: string }>> {
  const r = await db.execute(sql`
    select c.table_name as tabela, c.column_name as coluna
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
    where c.table_schema = 'futbolsa' and c.data_type = 'timestamp with time zone'
    order by c.table_name, c.column_name`);
  return r.rows.map((x) => ({ tabela: String(x.tabela), coluna: String(x.coluna) }));
}

const ident = (nome: string) => `"${nome.replace(/"/g, '""')}"`;

/**
 * Procura os vazamentos do relógio real e devolve a lista (vazia quando está tudo certo). `limite` é o relógio simulado de agora;
 * `anoDoEnsaio` é o ano da temporada (2025 no ensaio comparável).
 */
export async function procurarRelogioReal(db: Leitor, anoDoEnsaio: number, limite: Date, opcoes: OpcoesDetector = {}): Promise<AchadoRelogio[]> {
  const agoraReal = (opcoes.agoraReal ?? new Date()).getTime();
  const permitidas = { ...FUTURAS_PERMITIDAS, ...opcoes.futurasPermitidas };
  const teto = new Date(limite.getTime() + DIA).toISOString();
  const piso = new Date(Date.UTC(anoDoEnsaio - 1, 0, 1)).toISOString();
  const olharHojeReal = Math.abs(limite.getTime() - agoraReal) > DISTANCIA_MINIMA_DO_REAL;
  const hojeDe = new Date(agoraReal - DIA).toISOString();
  const hojeAte = new Date(agoraReal + DIA).toISOString();

  const achados: AchadoRelogio[] = [];
  for (const { tabela, coluna } of await colunasTimestamptz(db)) {
    if (!opcoes.estrito && `${tabela}.${coluna}` in RELOGIO_REAL_CONHECIDO) continue;
    const t =`futbolsa.${ident(tabela)}`;
    const c = ident(coluna);
    const futuroLiberado = `${tabela}.${coluna}` in permitidas;
    // uma consulta por coluna, com as três contagens (a tabela é lida uma vez)
    const r = await db.execute(
      sql.raw(`
        select
          count(*) filter (where ${c} > '${teto}'::timestamptz)::int as depois,
          max(${c}) filter (where ${c} > '${teto}'::timestamptz) as depois_ex,
          count(*) filter (where ${c} between '${hojeDe}'::timestamptz and '${hojeAte}'::timestamptz)::int as hoje,
          max(${c}) filter (where ${c} between '${hojeDe}'::timestamptz and '${hojeAte}'::timestamptz) as hoje_ex,
          count(*) filter (where ${c} < '${piso}'::timestamptz)::int as antes,
          min(${c}) filter (where ${c} < '${piso}'::timestamptz) as antes_ex
        from ${t}`),
    );
    const row = r.rows[0]!;
    const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
    if (!futuroLiberado && Number(row.depois) > 0) {
      achados.push({ tabela, coluna, regra: "depois_do_relogio_simulado", quantos: Number(row.depois), exemplo: iso(row.depois_ex) });
    }
    if (olharHojeReal && Number(row.hoje) > 0) {
      // a mesma linha pode já ter caído na regra 1; aqui ela ganha o motivo mais claro ("é o relógio de verdade")
      achados.push({ tabela, coluna, regra: "dia_de_hoje_real", quantos: Number(row.hoje), exemplo: iso(row.hoje_ex) });
    }
    if (Number(row.antes) > 0) {
      achados.push({ tabela, coluna, regra: "antes_do_ano_do_ensaio", quantos: Number(row.antes), exemplo: iso(row.antes_ex) });
    }
  }
  return achados;
}

const EXPLICACAO: Record<AchadoRelogio["regra"], string> = {
  depois_do_relogio_simulado: "depois do relógio simulado + 1 dia",
  dia_de_hoje_real: "no dia de hoje do relógio real",
  antes_do_ano_do_ensaio: "antes do ano anterior ao do ensaio",
};

/** Uma linha legível por achado, para a mensagem do erro e o relatório. */
export function descreverAchado(a: AchadoRelogio): string {
  return `relógio real: ${a.tabela}.${a.coluna} tem ${a.quantos} valor(es) ${EXPLICACAO[a.regra]} (ex.: ${a.exemplo}) — um now() escapou do Clock`;
}

/**
 * Falha se alguma coluna `timestamptz` tem valor que só o relógio real explicaria (veja `procurarRelogioReal`). A mensagem diz a
 * tabela, a coluna, quantos valores e um exemplo.
 */
export async function detectarRelogioReal(db: Leitor, anoDoEnsaio: number, limite: Date, opcoes: OpcoesDetector = {}): Promise<void> {
  const achados = await procurarRelogioReal(db, anoDoEnsaio, limite, opcoes);
  if (achados.length > 0) {
    throw new Error(`detector de relógio real (relógio simulado em ${limite.toISOString()}):\n${achados.map(descreverAchado).join("\n")}`);
  }
}
