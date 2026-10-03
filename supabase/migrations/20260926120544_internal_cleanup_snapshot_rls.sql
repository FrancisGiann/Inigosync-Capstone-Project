alter table internal.owner_reservation_cleanup_snapshot enable row level security; revoke all on internal.owner_reservation_cleanup_snapshot from public, anon, authenticated;
