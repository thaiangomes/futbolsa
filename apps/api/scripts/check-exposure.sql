-- Confere que o esquema do jogo não fica exposto pela API de dados do Supabase (Plano do banco,
-- T11). Os papéis anon e authenticated são os da chave pública que vai para o site. Cada linha
-- devolvida é um acesso indevido; a resposta certa é nenhuma linha.

-- uso do esquema; public é um pseudo-papel, que não aparece em pg_roles
select 'schema' as kind, v.role, 'futbolsa' as object, 'USAGE' as privilege
from (values ('anon'), ('authenticated'), ('public')) as v (role)
-- o case garante que o papel existe antes de perguntar (fora do Supabase, anon não existe)
where case
  when v.role = 'public' or exists (select 1 from pg_roles r where r.rolname = v.role)
    then has_schema_privilege(v.role, 'futbolsa', 'USAGE')
  else false
end

union all

-- privilégios nas tabelas, inclusive os dados ao papel public
select 'table', g.grantee, g.table_name, g.privilege_type
from information_schema.role_table_grants g
where g.table_schema = 'futbolsa'
  and g.grantee in ('anon', 'authenticated', 'PUBLIC')

union all

-- privilégios padrão (do esquema futbolsa ou de todos os esquemas) que dariam acesso às
-- tabelas criadas depois; grantee 0 é o papel public
select 'default', coalesce(r.rolname, 'PUBLIC'), coalesce(n.nspname, '(todos os esquemas)'), a.privilege_type
from pg_default_acl d
left join pg_namespace n on n.oid = d.defaclnamespace
cross join lateral aclexplode(d.defaclacl) a
left join pg_roles r on r.oid = a.grantee
where (n.nspname = 'futbolsa' or d.defaclnamespace = 0)
  and (a.grantee = 0 or r.rolname in ('anon', 'authenticated'));
