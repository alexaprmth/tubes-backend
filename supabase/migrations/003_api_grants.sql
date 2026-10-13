-- Data API privileges for the TransRent backend.
-- RLS remains enabled; these grants only allow the roles to reach the tables.

grant usage on schema public to service_role;

grant select, insert, update, delete on table
  public.rental_companies,
  public.branches,
  public.profiles,
  public.gps_devices,
  public.vehicles,
  public.reservations,
  public.payments,
  public.rentals,
  public.inspections,
  public.inspection_items,
  public.inspection_photos,
  public.fines,
  public.fine_disputes,
  public.refunds,
  public.maintenances,
  public.vehicle_locations
to service_role;

grant usage, select on all sequences in schema public to service_role;

-- Public catalog reads. RLS policies still restrict the rows returned.
grant usage on schema public to anon, authenticated;
grant select on table
  public.rental_companies,
  public.branches,
  public.vehicles
to anon, authenticated;

-- Customer-facing access. RLS policies in 002_profiles_and_rls.sql
-- restrict these grants to the current user's own rows.
grant select on table
  public.profiles,
  public.reservations,
  public.rentals,
  public.vehicle_locations
to authenticated;

grant insert on table public.reservations to authenticated;
