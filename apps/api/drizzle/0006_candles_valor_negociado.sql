ALTER TABLE "futbolsa"."candles" ADD COLUMN "turnover" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Valor negociado dos candles que já existem: a soma de preço × quantidade dos negócios não anulados de cada período
-- (15 minutos a partir do instante zero; o dia, de 0h a 24h de Brasília), a mesma conta de `recordTrade` e `rebuildCandles`.
UPDATE "futbolsa"."candles" c SET "turnover" = s.total
FROM (
	SELECT t.club_id, '15m'::text AS "interval", to_timestamp(floor(extract(epoch FROM t."at") / 900) * 900) AS "start", sum(t.price::numeric * t.quantity) AS total
	FROM "futbolsa"."trades" t
	WHERE NOT EXISTS (SELECT 1 FROM "futbolsa"."trade_annulments" ta WHERE ta.trade_id = t.id)
	GROUP BY 1, 2, 3
	UNION ALL
	SELECT t.club_id, '1d'::text AS "interval", date_trunc('day', t."at" AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo' AS "start", sum(t.price::numeric * t.quantity) AS total
	FROM "futbolsa"."trades" t
	WHERE NOT EXISTS (SELECT 1 FROM "futbolsa"."trade_annulments" ta WHERE ta.trade_id = t.id)
	GROUP BY 1, 2, 3
) s
WHERE c.club_id = s.club_id AND c."interval" = s."interval" AND c."start" = s."start";
