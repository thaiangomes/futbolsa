/** O endereço do WebSocket a partir do da API: `http` vira `ws`, `https` vira `wss`, e acrescenta `/ws`. */
export function wsUrlFromApiUrl(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/ws`;
}
