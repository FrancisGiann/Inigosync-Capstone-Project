-- Remove the per-bucket raw file size ceiling while retaining the public
-- access model and the image-only MIME guard. The project-wide Supabase
-- Storage limit may still reject files above its configured maximum.
update storage.buckets
set file_size_limit = null,
    allowed_mime_types = array['image/*']
where id = 'media';
