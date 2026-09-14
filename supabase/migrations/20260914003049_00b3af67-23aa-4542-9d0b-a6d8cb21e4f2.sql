create type public.app_role as enum ('admin', 'moderator', 'user');

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  role app_role not null,
  created_at timestamptz not null default now(),
  unique (user_id, role)
);

grant select on public.user_roles to authenticated;
grant all on public.user_roles to service_role;

alter table public.user_roles enable row level security;

create policy "Users can view their own roles"
on public.user_roles for select to authenticated
using (auth.uid() = user_id);

create or replace function public.has_role(_user_id uuid, _role app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role = _role)
$$;

create table public.admin_allowlist (
  email text primary key,
  created_at timestamptz not null default now()
);
grant all on public.admin_allowlist to service_role;
alter table public.admin_allowlist enable row level security;

insert into public.admin_allowlist (email) values ('mike@yourmarketingdude.com'), ('mike@sweetassist.com');

create or replace function public.grant_admin_for_allowlisted()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.email_confirmed_at is not null
     and exists (select 1 from public.admin_allowlist a where a.email = lower(new.email)) then
    insert into public.user_roles (user_id, role) values (new.id, 'admin')
    on conflict (user_id, role) do nothing;
  end if;
  return new;
end;
$$;

revoke execute on function public.grant_admin_for_allowlisted() from public, anon, authenticated;
revoke execute on function public.has_role(uuid, app_role) from anon;

create trigger on_auth_user_created_grant_admin
after insert on auth.users
for each row execute function public.grant_admin_for_allowlisted();

create trigger on_auth_user_confirmed_grant_admin
after update of email_confirmed_at on auth.users
for each row when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
execute function public.grant_admin_for_allowlisted();

insert into public.user_roles (user_id, role)
select id, 'admin' from auth.users where lower(email) = 'mike@yourmarketingdude.com'
on conflict (user_id, role) do nothing;