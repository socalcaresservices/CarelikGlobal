begin;

create index if not exists client_requested_schedule_organization_idx
  on public.client_requested_schedule (organization_id);
create index if not exists client_requested_schedule_created_by_idx
  on public.client_requested_schedule (created_by)
  where created_by is not null;
create index if not exists client_service_gap_reviews_service_idx
  on public.client_service_gap_reviews (service_id);
create index if not exists client_service_gap_reviews_updated_by_idx
  on public.client_service_gap_reviews (updated_by)
  where updated_by is not null;

commit;
