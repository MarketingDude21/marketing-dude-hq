ALTER TABLE public.agents ADD COLUMN IF NOT EXISTS onboarding_legacy boolean NOT NULL DEFAULT false;

-- Grandfather clause per Mike (2026-11-25): every agent who existed before
-- the Start Here onboarding shipped is treated as fully set up, so the new
-- step gates never lock them out.
UPDATE public.agents SET onboarding_legacy = true WHERE onboarding_legacy = false;