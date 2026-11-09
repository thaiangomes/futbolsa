"use client";

import { useEffect, useState } from "react";
import { healthResponseSchema, type HealthResponse } from "@futbolsa/contracts";
import { RealtimeStatusLine } from "../realtime/react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

export default function Home() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_URL}/health`)
      .then((res) => res.json())
      .then((corpo) => setHealth(healthResponseSchema.parse(corpo)))
      .catch((e: unknown) => setErro(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <main style={{ fontFamily: "sans-serif", padding: 24 }}>
      <h1>FutBolsa</h1>
      <p>
        API: {erro ? `fora do ar (${erro})` : health ? `${health.status} (preço mínimo ${health.minPrice} centavos)` : "consultando…"}
      </p>
      <nav aria-label="Telas do jogo">
        <a href="/ipo">IPO dos clubes</a>
      </nav>
      <RealtimeStatusLine />
    </main>
  );
}
