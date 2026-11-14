-- Histórico grande para o cenário (e) da carga (T17): negócios, ordens, candles e extrato.
-- Os marcadores {{...}} são trocados por `cenarios/leituras.ts`:
--   {{season}} temporada, {{club}} clube quente, {{buyer}} e {{seller}} carteiras de jogador, {{n}} negócios, {{entries}} linhas de extrato
--   {{wallet_from}} e {{wallet_to}} faixa de carteiras de jogador que recebe as linhas de extrato
-- As linhas entram "prontas" (como os testes do mercado fazem em insertTrade): sem passar pelo motor. Os candles de 15 minutos e
-- diários também entram prontos, mas NÃO são os que os negócios gerariam: o verificador de invariantes (candles = negócios) não vale
-- depois deste arquivo, e o cenário (e) não o roda. As linhas de extrato são `adjustment` com caixa zero (não mexem no dinheiro).
-- A sequência das chaves é acertada no fim, para a API continuar gravando sem colidir.

do $$
declare ob bigint;
declare tb bigint;
begin
  select coalesce(max(id), 0) into ob from futbolsa.orders;
  select coalesce(max(id), 0) into tb from futbolsa.trades;
  -- as ordens: a venda é a de número ímpar (ob + 2g - 1) e a compra a de número par (ob + 2g) de cada negócio g
  insert into futbolsa.orders (id, season_id, club_id, wallet_id, side, type, quantity, filled, limit_price, reserved_cash, status, created_at, updated_at)
  overriding system value
  select ob + g, {{season}}, {{club}}, case when g % 2 = 0 then {{buyer}} else {{seller}} end,
         case when g % 2 = 0 then 'buy' else 'sell' end, 'limit', 10, 10, 4000, 0, 'filled',
         timestamptz '2027-01-04 13:00:00+00' + ((g + 1) / 2) * interval '20 seconds', timestamptz '2027-01-04 13:00:00+00' + ((g + 1) / 2) * interval '20 seconds'
  from generate_series(1, {{n}} * 2) g;
  insert into futbolsa.trades (id, season_id, club_id, at, price, quantity, buy_order_id, sell_order_id, buyer_wallet_id, seller_wallet_id, with_house, price_before, in_auction)
  overriding system value
  select tb + g, {{season}}, {{club}}, timestamptz '2027-01-04 13:00:00+00' + g * interval '20 seconds', 3800 + (g * 37) % 400, 10,
         ob + 2 * g, ob + 2 * g - 1, {{buyer}}, {{seller}}, false, 4000, false
  from generate_series(1, {{n}}) g;
end $$;

select setval(pg_get_serial_sequence('futbolsa.orders', 'id'), (select max(id) from futbolsa.orders));
select setval(pg_get_serial_sequence('futbolsa.trades', 'id'), (select max(id) from futbolsa.trades));

-- candles de 15 minutos e diários do clube quente, em cima do histórico
insert into futbolsa.candles (club_id, "interval", start, open, high, low, close, volume)
select {{club}}, '15m', timestamptz '2027-01-04 13:00:00+00' + g * interval '15 minutes', 3950, 4100, 3850, 4000, 120
from generate_series(0, {{n}} / 45) g
on conflict do nothing;
insert into futbolsa.candles (club_id, "interval", start, open, high, low, close, volume)
select {{club}}, '1d', timestamptz '2027-01-04 03:00:00+00' + g * interval '1 day', 3950, 4100, 3850, 4000, 5000
from generate_series(0, {{n}} / 4000) g
on conflict do nothing;

-- extrato: linhas `adjustment` de caixa zero nas carteiras da faixa, com o caixa de agora
insert into futbolsa.wallet_entries (wallet_id, at, kind, cash_delta, cash_after, reason)
select w.id, timestamptz '2027-01-04 13:00:00+00' + (g % 100000) * interval '30 seconds', 'adjustment', 0, w.cash, 'histórico da carga'
from generate_series(1, {{entries}}) g
join futbolsa.wallets w on w.id = {{wallet_from}} + (g % ({{wallet_to}} - {{wallet_from}} + 1));
