/**
 * Relógio da API. Nada lê Date.now() direto: tudo pede a hora a este provedor,
 * para os testes poderem fixar e andar o tempo (relógio explícito, como no motor).
 * Horários são instantes em UTC; dias e meses do jogo contam no fuso de Brasília.
 */
export abstract class Clock {
  abstract now(): Date;
}

/** Relógio real, usado em produção. */
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

/** Relógio fixo e controlável, para os testes. */
export class FixedClock extends Clock {
  constructor(private current: Date) {
    super();
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(instant: Date): void {
    this.current = new Date(instant.getTime());
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
