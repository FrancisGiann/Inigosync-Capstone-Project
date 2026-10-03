do $$ begin execute replace(pg_get_functiondef('internal.prevent_reservation_overlap()'::regprocedure), 'pg_catalog.nullif', 'nullif'); end $$;
