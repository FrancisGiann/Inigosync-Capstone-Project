
-- Job-title label for staff (e.g. "Front Desk", "Court Attendant"), display-only —
-- access control is still driven purely by profiles.role.
alter table public.profiles add column position text;
