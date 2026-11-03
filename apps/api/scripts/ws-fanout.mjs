// Medição do fan-out do tempo real (Plano do WebSocket, T7): abre N conexões em 127.0.0.1,
// todas assinando o mesmo clube, publica M eventos e imprime o atraso de entrega (p50 e p95)
// e a memória. Não é teste automático: o tempo depende da máquina.
//
//   npm run build -w @futbolsa/api
//   node apps/api/scripts/ws-fanout.mjs [conexões=1000] [eventos=100]
//
// Sobe a API de dentro do próprio processo (o `dist` compilado), então as 1.000 conexões e o
// servidor dividem a mesma máquina e o mesmo laço de eventos: o número é um teto de custo,
// não de latência de rede.
import "reflect-metadata";
import { performance } from "node:perf_hooks";
import WebSocket from "ws";

const connections = Number(process.argv[2] ?? 1000);
const events = Number(process.argv[3] ?? 100);
const origin = "http://localhost:3001";

process.env.WEB_ORIGIN = origin;
process.env.WS_MAX_CONNECTIONS = String(connections + 10);

const { createApp } = await import("../dist/app.js");
const { EventBus } = await import("../dist/infra/realtime/bus.js");

const app = await createApp();
await app.listen(0, "127.0.0.1");
const { port } = app.getHttpServer().address();
const bus = app.get(EventBus);

const memoryBefore = process.memoryUsage();
const delays = [];
let received = 0;
const sockets = [];

console.log(`abrindo ${connections} conexões na porta ${port}...`);
function openOne() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin });
    sockets.push(socket);
    socket.on("error", reject);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "subscribed") return resolve();
      if (message.type !== "trade") return;
      received += 1;
      delays.push(performance.now() - message.data.sentAt);
    });
    socket.on("open", () => socket.send(JSON.stringify({ type: "subscribe", channel: "club:FLA3" })));
  });
}

// em levas: a fila de conexões pendentes do sistema operacional é curta (cerca de 500)
for (let opened = 0; opened < connections; opened += 100) {
  await Promise.all(Array.from({ length: Math.min(100, connections - opened) }, openOne));
}

const memoryConnected = process.memoryUsage();
console.log(`publicando ${events} eventos...`);
const started = performance.now();
for (let i = 0; i < events; i++) {
  bus.publish("club:FLA3", "trade", { id: String(i), sentAt: performance.now() });
  // um evento por laço, como acontece no jogo (cada negócio é uma transação)
  await new Promise((resolve) => setImmediate(resolve));
}

const expected = connections * events;
const deadline = Date.now() + 30_000;
while (received < expected && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
const elapsed = performance.now() - started;

delays.sort((a, b) => a - b);
const percentile = (p) => (delays.length === 0 ? NaN : delays[Math.min(delays.length - 1, Math.floor(delays.length * p))]);
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);
const stats = app.get((await import("../dist/infra/realtime/gateway.js")).RealtimeGateway).stats();

console.log("");
console.log(`conexões:          ${stats.connections}`);
console.log(`entregas:          ${received} de ${expected}`);
console.log(`tempo total:       ${elapsed.toFixed(0)} ms`);
console.log(`atraso p50:        ${percentile(0.5).toFixed(1)} ms`);
console.log(`atraso p95:        ${percentile(0.95).toFixed(1)} ms`);
console.log(`atraso máximo:     ${(delays.at(-1) ?? NaN).toFixed(1)} ms`);
console.log(`memória (heap):    ${mb(memoryBefore.heapUsed)} MB antes, ${mb(memoryConnected.heapUsed)} MB com as conexões, ${mb(process.memoryUsage().heapUsed)} MB depois`);
console.log(`memória (rss):     ${mb(process.memoryUsage().rss)} MB`);
console.log(`bytes parados:     ${stats.bufferedBytes}`);

for (const socket of sockets) socket.terminate();
await app.close();
process.exit(received === expected ? 0 : 1);
