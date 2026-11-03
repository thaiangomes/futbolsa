/** Lê um número de uma variável de ambiente; vazio ou inválido volta ao padrão. */
function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Tamanho máximo de uma mensagem do cliente (o `ws` fecha com 1009 acima disso). Fixo na carga do módulo. */
export const MAX_MESSAGE_BYTES = 4_096;

/**
 * Limites do tempo real. Lidos a cada conexão, não na carga do módulo, para os testes
 * ajustarem pelo ambiente. Os números são os iniciais do Plano do WebSocket; o teste de
 * carga da F16 mede e ajusta.
 */
export function realtimeLimits() {
  return {
    /** Prazo para a primeira mensagem válida; passado isso a conexão fecha com 4408. */
    firstMessageTimeoutMs: numberFromEnv("WS_FIRST_MESSAGE_TIMEOUT_MS", 10_000),
    /** Mensagens do cliente por segundo, por conexão; acima disso fecha com 1008. */
    maxMessagesPerSecond: numberFromEnv("WS_MAX_MESSAGES_PER_SECOND", 20),
    /** Assinaturas por conexão. */
    maxSubscriptions: numberFromEnv("WS_MAX_SUBSCRIPTIONS", 40),
    /** Conexões por pessoa; a 6ª derruba a mais antiga. */
    maxConnectionsPerUser: numberFromEnv("WS_MAX_CONNECTIONS_PER_USER", 5),
    /** Conexões no total; acima disso a nova é recusada. */
    maxConnections: numberFromEnv("WS_MAX_CONNECTIONS", 20_000),
    /** De quanto em quanto tempo o servidor manda `heartbeat` ao cliente. */
    heartbeatMs: numberFromEnv("WS_HEARTBEAT_MS", 25_000),
    /** De quanto em quanto tempo o servidor manda `ping`. */
    pingMs: numberFromEnv("WS_PING_MS", 30_000),
    /** Vida máxima de uma conexão autenticada (o token vale cerca de uma hora). */
    maxAgeMs: numberFromEnv("WS_MAX_AGE_MS", 55 * 60_000),
    /** Bytes parados no envio de um cliente que não lê; acima disso ele é derrubado. */
    slowClientBytes: numberFromEnv("WS_SLOW_CLIENT_BYTES", 1_048_576),
  };
}

export type RealtimeLimits = ReturnType<typeof realtimeLimits>;
