CREATE TABLE public.sso_nonces (
  nonce text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.sso_nonces TO service_role;
ALTER TABLE public.sso_nonces ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.sso_rate_limits (
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
GRANT ALL ON public.sso_rate_limits TO service_role;
ALTER TABLE public.sso_rate_limits ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.sso_bump_rate_limit(_bucket text, _window_start timestamptz)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  INSERT INTO public.sso_rate_limits (bucket, window_start, count)
  VALUES (_bucket, _window_start, 1)
  ON CONFLICT (bucket, window_start)
  DO UPDATE SET count = public.sso_rate_limits.count + 1
  RETURNING count;
$$;

CREATE OR REPLACE FUNCTION public.sso_find_auth_user(_email text)
RETURNS TABLE (id uuid, email text, email_confirmed_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT u.id, u.email::text, u.email_confirmed_at
  FROM auth.users u
  WHERE lower(u.email) = lower(trim(_email));
$$;

REVOKE ALL ON FUNCTION public.sso_bump_rate_limit(text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sso_find_auth_user(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sso_bump_rate_limit(text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.sso_find_auth_user(text) TO service_role;