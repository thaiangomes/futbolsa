/** Lê um número de uma variável de ambiente; vazio ou inválido volta ao padrão. */
function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Limites do tempo real. Lidos a cada conexão, não na carga do módulo, para os testes
 * ajustarem pelo ambiente. Os números são os iniciais do Plano do WebSocket; o teste de
 * carga da F16 mede e ajusta.
 */
export function realtimeLimits() {
  return {
    /** Prazo para a primeira mensagem válida; passado isso a conexão fecha com 4408. */
    firstMessageTimeoutMs: numberFromEnv("WS_FIRST_MESSAGE_TIMEOUT_MS", 10_000),
  };
}

export type RealtimeLimits = ReturnType<typeof realtimeLimits>;
