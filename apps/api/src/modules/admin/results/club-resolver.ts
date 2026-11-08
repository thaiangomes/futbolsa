import { clubIdFromName } from "@futbolsa/engine";
import type { Tx } from "../../../infra/db/index.js";
import { clubs } from "../../../infra/db/schema/index.js";

/** Siglas de tipo de clube que as fontes põem antes ou depois do nome ("Coritiba FC", "CR Flamengo"). */
const SUFFIXES = new Set(["fc", "ec", "sc", "ac", "ca", "cr", "se", "fr", "fbpa", "futebol", "clube", "esporte", "de", "regatas"]);

/**
 * O nome do clube para comparar: sem acento, em minúsculas, sem os sufixos de tipo de clube
 * (FC, EC, "Esporte Clube"...). "Atlético-MG" continua com o "-mg": é o que o distingue.
 */
export function normalizeClubName(name: string): string {
  const base = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const words = base.split(" ");
  const kept = words.filter((w, i) => !(SUFFIXES.has(w) && words.length > 1 && (i === 0 || i === words.length - 1 || SUFFIXES.has(words[i - 1]!))));
  return (kept.length > 0 ? kept : words).join(" ");
}

export interface ResolvedClub {
  id: number;
  ticker: string | null;
  name: string;
  /** O clube não existia e foi criado agora, sem ticker (clube não listado). */
  created: boolean;
}

/** Acha pelo apelido do motor, tentando o nome como veio e o nome sem os sufixos. Erro do motor vira `undefined`. */
function engineTicker(name: string): string | undefined {
  for (const candidate of [name, normalizeClubName(name)]) {
    try {
      return clubIdFromName(candidate);
    } catch {
      // nome que o motor não conhece
    }
  }
  return undefined;
}

/**
 * O clube de um nome de fonte. Tenta o apelido do motor (`Vasco da Gama` é VAS3), depois o nome
 * sem acento, maiúsculas e sufixos contra os clubes já conhecidos; o que não achar entra em
 * `clubs` sem ticker (clube não listado, da Série B ou de fora do país). Se a ESPN e a
 * football-data escreverem o mesmo clube diferente, nasce um duplicado: o relatório da
 * importação lista os clubes criados para o admin conferir.
 */
export async function resolveClub(tx: Tx, name: string): Promise<ResolvedClub> {
  const cleaned = name.trim();
  const known = await tx.db.select().from(clubs);

  const ticker = engineTicker(cleaned);
  if (ticker) {
    const listed = known.find((c) => c.ticker === ticker);
    if (listed) return { id: listed.id, ticker: listed.ticker, name: listed.name, created: false };
  }

  const wanted = normalizeClubName(cleaned);
  const match = known.find((c) => normalizeClubName(c.name) === wanted);
  if (match) return { id: match.id, ticker: match.ticker, name: match.name, created: false };

  const [created] = await tx.db.insert(clubs).values({ name: cleaned }).returning();
  return { id: created!.id, ticker: null, name: created!.name, created: true };
}
