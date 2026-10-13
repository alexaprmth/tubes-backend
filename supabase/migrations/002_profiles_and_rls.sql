create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, name, email, role, verification_status)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)), new.email, 'CUSTOMER', 'PENDING')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

create policy "public can read active rental companies"
on public.rental_companies for select
using (status = 'ACTIVE');

create policy "public can read branches"
on public.branches for select
using (true);

create policy "public can read bookable vehicles"
on public.vehicles for select
using (status = 'AVAILABLE' and gps_status = 'READY');

create policy "users can read own profile"
on public.profiles for select
to authenticated
using (id = auth.uid());

create policy "customers can read own reservations"
on public.reservations for select
to authenticated
using (customer_id = auth.uid());

create policy "customers can create own reservations"
on public.reservations for insert
to authenticated
with check (customer_id = auth.uid());

create policy "customers can read own rentals"
on public.rentals for select
to authenticated
using (customer_id = auth.uid());

create policy "customers can read own rental locations"
on public.vehicle_locations for select
to authenticated
using (exists (
  select 1 from public.rentals r
  where r.id = vehicle_locations.rental_id
    and r.customer_id = auth.uid()
    and r.status = 'ACTIVE'
));

-- Backend uses the service role for cross-company operational actions.
-- Never expose the service role key to the frontend.
