// Returns true once the Supabase integration is connected (Project Settings →
// Connectors). Until then the shell runs in preview mode.
export const backendConfigured = Boolean(
  import.meta.env["VITE_SUPABASE_URL"],
);
