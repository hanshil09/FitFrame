-- Private noncommercial research kits. Admin/server credentials are required.
begin;

create table if not exists public.furniture_kits (
  article_number text primary key check (article_number ~ '^[0-9]{8}$'),
  name text not null,
  manual_id text not null,
  model_path text not null,
  manual_path text not null,
  mesh_nodes integer not null check (mesh_nodes > 0),
  source_url text not null,
  model_license text not null
);

alter table public.furniture_kits enable row level security;
revoke all on public.furniture_kits from anon, authenticated;
grant select, insert, update on public.furniture_kits to service_role;

insert into storage.buckets (id, name, public, allowed_mime_types)
values ('furniture-kits', 'furniture-kits', false,
        array['model/gltf-binary', 'application/octet-stream', 'application/pdf'])
on conflict (id) do nothing;

commit;
