# Inigosync-Capstone-Project
A web-based booking management system for Inigos sports center

## Build for static hosting

The frontend is plain HTML, CSS, and JavaScript. Run `npm run build` to create
`dist/`, with `index.html` at its root. Node.js 20 or newer is required for the
build script; there are no npm dependencies.

For Hostinger's Git repository import, select the **Other** framework, set the
build command to `npm run build`, and set the output directory to `dist`. The
build includes the public frontend and its image assets. Supabase migrations,
Edge Functions, tests, and project documents are excluded. Supabase backend
configuration and payment readiness must be completed separately before
publishing the booking flow.
