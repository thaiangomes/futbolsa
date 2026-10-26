/**
 * Clubes conhecidos, com ticker próprio (sem escudos ou marcas oficiais) e os
 * apelidos usados pelas fontes de dados para casar os nomes.
 */

export interface ClubInfo {
  id: string;
  name: string;
  /** Nomes usados por openfootball e football-data.org (sem acento, minúsculos). */
  aliases: string[];
}

export const CLUBS: ClubInfo[] = [
  { id: "FLA3", name: "Flamengo", aliases: ["cr flamengo", "flamengo"] },
  { id: "FLU3", name: "Fluminense", aliases: ["fluminense fc", "fluminense"] },
  { id: "VAS3", name: "Vasco da Gama", aliases: ["cr vasco da gama", "vasco da gama", "vasco"] },
  { id: "BOT3", name: "Botafogo", aliases: ["botafogo fr", "botafogo"] },
  { id: "COR3", name: "Corinthians", aliases: ["sc corinthians paulista", "corinthians"] },
  { id: "PAL3", name: "Palmeiras", aliases: ["se palmeiras", "palmeiras"] },
  { id: "SAO3", name: "São Paulo", aliases: ["sao paulo fc", "sao paulo"] },
  { id: "SAN3", name: "Santos", aliases: ["santos fc", "santos"] },
  { id: "GRE3", name: "Grêmio", aliases: ["gremio fbpa", "gremio"] },
  { id: "INT3", name: "Internacional", aliases: ["sc internacional", "internacional"] },
  { id: "CRU3", name: "Cruzeiro", aliases: ["cruzeiro ec", "cruzeiro"] },
  { id: "CAM3", name: "Atlético-MG", aliases: ["ca mineiro", "atletico mineiro", "atletico-mg", "clube atletico mineiro"] },
  { id: "BAH3", name: "Bahia", aliases: ["ec bahia", "bahia"] },
  { id: "FOR3", name: "Fortaleza", aliases: ["fortaleza ec", "fortaleza"] },
  { id: "CEA3", name: "Ceará", aliases: ["ceara sc", "ceara"] },
  { id: "SPT3", name: "Sport", aliases: ["sc recife", "sport recife", "sport club do recife", "sport"] },
  { id: "JUV3", name: "Juventude", aliases: ["ec juventude", "juventude"] },
  { id: "VIT3", name: "Vitória", aliases: ["ec vitoria", "vitoria"] },
  { id: "MIR3", name: "Mirassol", aliases: ["mirassol fc", "mirassol"] },
  { id: "RBB3", name: "Bragantino", aliases: ["rb bragantino", "red bull bragantino", "bragantino"] },
];

/** Clube dos Treze: listados todo ano, mesmo na Série B (decisão do Thaian). */
export const CLUBE_DOS_TREZE = [
  "FLA3", "FLU3", "VAS3", "BOT3", "COR3", "PAL3", "SAO3", "SAN3", "GRE3", "INT3", "CRU3", "CAM3", "BAH3",
];

const normalize = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

export function clubIdFromName(name: string): string {
  const n = normalize(name);
  const club = CLUBS.find((c) => c.aliases.includes(n));
  if (!club) throw new Error(`Clube desconhecido: "${name}". Adicione um apelido em src/data/clubs.ts`);
  return club.id;
}

export function clubName(id: string): string {
  return CLUBS.find((c) => c.id === id)?.name ?? id;
}

/**
 * Colocação usada para o preço do IPO de 2025: a tabela final do Brasileirão
 * 2024; os quatro promovidos (Santos, Mirassol, Sport, Ceará, na ordem da
 * Série B 2024) usam os preços do 17º ao 20º, como manda o plano.
 */
export const IPO_POSITIONS_2025: Record<string, number> = {
  BOT3: 1, PAL3: 2, FLA3: 3, FOR3: 4, INT3: 5, SAO3: 6, COR3: 7, BAH3: 8, CRU3: 9, VAS3: 10,
  VIT3: 11, CAM3: 12, FLU3: 13, GRE3: 14, JUV3: 15, RBB3: 16, SAN3: 17, MIR3: 18, SPT3: 19, CEA3: 20,
};
