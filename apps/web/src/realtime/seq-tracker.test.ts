import { describe, expect, it } from "vitest";
import { SeqTracker } from "./seq-tracker";

/** Passa a lista de seq pelo rastreador e devolve o que ele decidiu para cada um. */
function run(tracker: SeqTracker, seqs: number[]) {
  return seqs.map((seq) => [seq, tracker.accept(seq)] as const);
}

describe("rastreador de seq (T8)", () => {
  it("C22: aplica último + 1, em ordem", () => {
    const tracker = new SeqTracker();
    expect(run(tracker, [1, 2, 3])).toEqual([
      [1, "apply"],
      [2, "apply"],
      [3, "apply"],
    ]);
    expect(tracker.last).toBe(3);
  });

  it("C22: descarta o repetido e o antigo", () => {
    const tracker = new SeqTracker(10);
    expect(run(tracker, [10, 9, 1, 11, 11, 10])).toEqual([
      [10, "stale"],
      [9, "stale"],
      [1, "stale"],
      [11, "apply"],
      [11, "stale"],
      [10, "stale"],
    ]);
    expect(tracker.last).toBe(11);
  });

  it("C22: 1, 2, 4, 3 aplica 1 e 2, acusa buraco no 4 e não aplica 4 nem 3 antes da recarga", () => {
    const tracker = new SeqTracker();
    expect(run(tracker, [1, 2, 4, 3])).toEqual([
      [1, "apply"],
      [2, "apply"],
      [4, "gap"],
      [3, "gap"],
    ]);
    expect(tracker.last).toBe(2);
    expect(tracker.hasGap).toBe(true);
  });

  it("C22: 5, 7, 6 aplica o 5, acusa buraco no 7 e não aplica o 6", () => {
    const tracker = new SeqTracker();
    expect(run(tracker, [5, 7, 6])).toEqual([
      [5, "apply"],
      [7, "gap"],
      [6, "gap"],
    ]);
  });

  it("C22: depois de um buraco, nada é aplicado até a recarga; a recarga reposiciona no seq da carga", () => {
    const tracker = new SeqTracker(100);
    expect(tracker.accept(105)).toBe("gap");
    expect(tracker.accept(101)).toBe("gap");
    tracker.reset(105);
    expect(tracker.hasGap).toBe(false);
    expect(run(tracker, [104, 105, 106])).toEqual([
      [104, "stale"],
      [105, "stale"],
      [106, "apply"],
    ]);
  });

  it("C22: o primeiro evento sem base vira a base (a assinatura sem recarga pela REST)", () => {
    const tracker = new SeqTracker();
    expect(tracker.last).toBeNull();
    expect(tracker.accept(1_800_000_000_123)).toBe("apply");
    expect(tracker.accept(1_800_000_000_124)).toBe("apply");
  });

  it("um seq que pula depois de um reinício da API (base nova, bem maior) é buraco", () => {
    const tracker = new SeqTracker(1_800_000_000_500);
    expect(tracker.accept(1_800_000_090_001)).toBe("gap");
  });

  it("a mesma regra vale para seq grandes (horário em milissegundos)", () => {
    const tracker = new SeqTracker(1_793_631_600_000);
    expect(run(tracker, [1_793_631_600_001, 1_793_631_600_002])).toEqual([
      [1_793_631_600_001, "apply"],
      [1_793_631_600_002, "apply"],
    ]);
  });
});
