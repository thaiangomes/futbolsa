# Dados de partidas

## `brasileirao-2025.json`

Os 380 jogos do Brasileirão Série A 2025, convertidos do
[openfootball/football.json](https://github.com/openfootball/football.json)
(domínio público, CC0) com:

```bash
npm run data:convert -- caminho/para/2025/br.1.json data/brasileirao-2025.json 2025
```

Também dá para gerar o mesmo arquivo pela API football-data.org, com a chave na
variável `FOOTBALL_DATA_KEY` (nunca commite a chave):

```bash
npm run data:fetch -- 2025
```

## Formato

```jsonc
{
  "season": 2025,
  "competition": "brasileirao-a",
  "source": "de onde vieram os dados",
  "clubs": [
    {
      "id": "FLA3",            // ticker do jogo (sem escudo nem marca oficial)
      "name": "Flamengo",
      "division": "A",         // "A" ou "B" nesta temporada
      "ipoPosition": 3         // colocação usada para o preço do IPO (1 a 20)
    }
  ],
  "matches": [
    {
      "id": "2025-r01-FLA3-INT3",
      "competition": "brasileirao-a",
      "round": 1,                              // rodada (pontos corridos)
      "phase": "oitavas",                      // só em copas, no lugar de round
      "kickoff": "2025-03-29T21:00:00-03:00",  // ISO 8601 com fuso
      "finishedAt": "2025-03-29T22:55:00-03:00", // opcional; padrão = início + 2 h
      "home": "FLA3",
      "away": "INT3",
      "homeGoals": 1,                          // null se não terminou
      "awayGoals": 1,
      "status": "finished",                    // "finished" | "scheduled" | "cancelled"
      "postponed": true,                       // opcional: disputado fora da janela da rodada
      "winner": "FLA3"                         // só em copas: quem avançou no jogo decisivo
    }
  ]
}
```

- `postponed` marca jogos adiados ou antecipados (mais de 3 dias longe da data
  mediana da rodada). Os pontos deles pagam no fechamento da primeira rodada que
  terminar depois do jogo. Os conversores calculam isso sozinhos
  (`markOutOfWindow` em `src/data/season.ts`). Em 2025 foram 19 jogos.
- `ipoPosition` em 2025 é a tabela final de 2024; os quatro promovidos (Santos,
  Mirassol, Sport e Ceará, na ordem da Série B 2024) ficam com o 17º ao 20º. Está
  em `src/data/clubs.ts`.

## `../tests/fixtures/mini-season.json`

Temporada fictícia de 4 clubes e 6 rodadas, com um jogo adiado, usada nos testes.
