import { Injectable } from "@nestjs/common";
import { entryError } from "./errors.js";

/** Quantas entradas esperam a sua vez nesta instância; a 51ª recebe `entry_busy` (P2). */
export const ENTRY_QUEUE_LIMIT = 50;

/**
 * Uma transação de entrada por vez em cada instância da API (P2). A entrada segura todos os clubes; duas esperando
 * uma na outra já se enfileiram na trava do primeiro clube, mas cada uma segurando uma conexão do conjunto (fixo, em
 * torno de 20). O semáforo evita que 20 entradas esgotem as conexões e deixem as ordens sem uma. A espera fica fora do
 * banco: quem espera aqui não segura conexão nem trava.
 */
@Injectable()
export class EntryGate {
  private running = false;
  private readonly waiting: Array<() => void> = [];

  /** Quantas entradas esperam a vez (para os testes). */
  get queued(): number {
    return this.waiting.length;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running) {
      if (this.waiting.length >= ENTRY_QUEUE_LIMIT) throw entryError("entry_busy");
      // a vez passa direto para o próximo da fila (`running` continua verdadeiro): ninguém fura a fila
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.running = true;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running = false;
    }
  }
}
