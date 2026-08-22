import { defineConfig } from 'vite';

// docs/app-session.md: the one thing Civil asks of a frontend's tooling — bind the
// port the session hands it in $PORT. strictPort, because silently drifting to a
// free port would break the preview URL the session derived.
export default defineConfig({
  server: process.env.PORT
    ? { port: Number(process.env.PORT), strictPort: true }
    : {},
});
