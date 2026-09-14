revoke execute on function public.has_role(uuid, app_role) from public, anon, authenticated;

grant select on public.admin_allowlist to authenticated;
create policy "Admins can view allowlist"
on public.admin_allowlist for select to authenticated
using (exists (select 1 from public.user_roles ur where ur.user_id = auth.uid() and ur.role = 'admin'));