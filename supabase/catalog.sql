-- Public read-only catalog for assets intentionally published by an administrator.
-- Keep unpublished GLBs in the private bucket. Publish only redistributable files.
begin;

create table if not exists public.furniture_assets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  family text not null,
  part_type text not null,
  storage_path text not null unique,
  dimensions_mm jsonb,
  attachment_points jsonb not null default '{}',
  source_url text not null,
  license text not null,
  published boolean not null default false
);

alter table public.furniture_assets enable row level security;
grant select on public.furniture_assets to anon, authenticated;
revoke insert, update, delete, truncate on public.furniture_assets from anon, authenticated;
drop policy if exists "Read published furniture assets" on public.furniture_assets;
create policy "Read published furniture assets" on public.furniture_assets
  for select to anon, authenticated using (published);

insert into storage.buckets (id, name, public, allowed_mime_types)
values ('furniture-assets', 'furniture-assets', false, array['model/gltf-binary', 'application/octet-stream'])
on conflict (id) do nothing;

drop policy if exists "Read published furniture models" on storage.objects;
create policy "Read published furniture models" on storage.objects
  for select to anon, authenticated
  using (
    bucket_id = 'furniture-assets'
    and exists (
      select 1 from public.furniture_assets asset
      where asset.storage_path = storage.objects.name and asset.published
    )
  );

commit;
