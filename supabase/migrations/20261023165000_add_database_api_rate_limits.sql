-- Shared, database-backed per-user API rate limiting for serverless deployments.
-- Direct table access is denied; callers can only consume their own fixed endpoint quota
-- through the guarded RPC function below.

CREATE TABLE IF NOT EXISTS public.api_rate_limits (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint text NOT NULL CHECK (endpoint IN ('chat', 'agent', 'speech')),
  window_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  PRIMARY KEY (user_id, endpoint)
);

ALTER TABLE public.api_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.api_rate_limits FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.consume_api_rate_limit(p_endpoint text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_limit integer;
  v_window_seconds integer := 60;
  v_count integer;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  CASE p_endpoint
    WHEN 'chat' THEN v_limit := 20;
    WHEN 'agent' THEN v_limit := 6;
    WHEN 'speech' THEN v_limit := 30;
    ELSE RAISE EXCEPTION 'Invalid rate-limit endpoint' USING ERRCODE = '22023';
  END CASE;

  INSERT INTO public.api_rate_limits (user_id, endpoint, window_started_at, request_count)
  VALUES (v_user_id, p_endpoint, clock_timestamp(), 1)
  ON CONFLICT (user_id, endpoint) DO UPDATE
  SET
    window_started_at = CASE
      WHEN public.api_rate_limits.window_started_at <= clock_timestamp() - make_interval(secs => v_window_seconds)
        THEN clock_timestamp()
      ELSE public.api_rate_limits.window_started_at
    END,
    request_count = CASE
      WHEN public.api_rate_limits.window_started_at <= clock_timestamp() - make_interval(secs => v_window_seconds)
        THEN 1
      ELSE public.api_rate_limits.request_count + 1
    END
  RETURNING request_count INTO v_count;

  RETURN v_count <= v_limit;
END;
$function$;

-- The RPC has a fixed endpoint allow-list and derives identity from the verified JWT.
-- It does not accept caller-controlled user IDs or caller-controlled quota values.
REVOKE ALL ON FUNCTION public.consume_api_rate_limit(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consume_api_rate_limit(text) TO authenticated;
