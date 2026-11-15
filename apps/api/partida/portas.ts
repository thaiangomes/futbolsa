/** Portas da partida (a API pública, atrás do túnel, fica na 4000) (todas em 127.0.0.1): o site de teste é construído apontando para a da API. */
export const PORTAS_DA_PARTIDA = { api: 3200, site: 3201, controle: 3202, apiPublica: 4000 } as const;
