import { Injectable } from "@nestjs/common";
import { entryError } from "./errors.js";

/** Quantas entradas esperam a sua vez nesta instância; a 51ª recebe `entry_busy` (P2). */
export const ENTRY_QUEUE_LIMIT = 50;

/** Quanto tempo uma entrada espera na fila antes de receber `entry_busy` (a tela tenta de novo). */
export const ENTRY_QUEUE_WAIT_MS = 30_000;

interface Waiter {
  go: () => void;
  timer: NodeJS.Timeout;
}

/**
 * Uma transação de entrada por vez em cada instância da API (P2). A entrada segura todos os clubes; duas esperando
 * uma na outra já se enfileiram na trava do primeiro clube, mas cada uma segurando uma conexão do conjunto (fixo, em
 * torno de 20). O semáforo evita que 20 entradas esgotem as conexões e deixem as ordens sem uma. A espera fica fora do
 * banco: quem espera aqui não segura conexão nem trava, e desiste com `entry_busy` depois de 30 s.
 */
@Injectable()
export class EntryGate {
  private running = false;
  private readonly waiting: Waiter[] = [];

  /** Público só para os testes encurtarem a espera. */
  waitMs = ENTRY_QUEUE_WAIT_MS;

  /** Quantas entradas esperam a vez (para os testes). */
  get queued(): number {
    return this.waiting.length;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running) {
      if (this.waiting.length >= ENTRY_QUEUE_LIMIT) throw entryError("entry_busy");
      // a vez passa direto para o próximo da fila (`running` continua verdadeiro): ninguém fura a fila
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          go: resolve,
          timer: setTimeout(() => {
            this.waiting.splice(this.waiting.indexOf(waiter), 1);
            reject(entryError("entry_busy"));
          }, this.waitMs),
        };
        this.waiting.push(waiter);
      });
    } else {
      this.running = true;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) {
        clearTimeout(next.timer);
        next.go();
      } else {
        this.running = false;
      }
    }
  }
}
