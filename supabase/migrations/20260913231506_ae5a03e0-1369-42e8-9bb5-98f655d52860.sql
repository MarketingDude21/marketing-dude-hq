CREATE TABLE public.agents (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  full_name TEXT,
  brokerage TEXT,
  market_area TEXT,
  phone TEXT,
  website TEXT,
  headshot_url TEXT,
  voice_answers JSONB NOT NULL DEFAULT '{}'::jsonb,
  voice_summary TEXT,
  subscription_status TEXT NOT NULL DEFAULT 'trial',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agents TO authenticated;
GRANT ALL ON public.agents TO service_role;
ALTER TABLE public.agents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Agents manage own profile" ON public.agents FOR ALL TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

CREATE TABLE public.generated_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  title TEXT,
  content TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'social',
  platform TEXT,
  month TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  scheduled_for TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.generated_posts TO authenticated;
GRANT ALL ON public.generated_posts TO service_role;
ALTER TABLE public.generated_posts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Agents manage own posts" ON public.generated_posts FOR ALL TO authenticated USING (auth.uid() = agent_id) WITH CHECK (auth.uid() = agent_id);
CREATE INDEX generated_posts_agent_idx ON public.generated_posts(agent_id, created_at DESC);

CREATE TABLE public.feedback_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  post_id UUID REFERENCES public.generated_posts(id) ON DELETE SET NULL,
  rating TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.feedback_history TO authenticated;
GRANT ALL ON public.feedback_history TO service_role;
ALTER TABLE public.feedback_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Agents manage own feedback" ON public.feedback_history FOR ALL TO authenticated USING (auth.uid() = agent_id) WITH CHECK (auth.uid() = agent_id);
CREATE INDEX feedback_history_agent_idx ON public.feedback_history(agent_id, created_at DESC);

CREATE TABLE public.agent_photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  storage_path TEXT,
  url TEXT,
  caption TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_photos TO authenticated;
GRANT ALL ON public.agent_photos TO service_role;
ALTER TABLE public.agent_photos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Agents manage own photos" ON public.agent_photos FOR ALL TO authenticated USING (auth.uid() = agent_id) WITH CHECK (auth.uid() = agent_id);
CREATE INDEX agent_photos_agent_idx ON public.agent_photos(agent_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_agents_updated_at BEFORE UPDATE ON public.agents FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_generated_posts_updated_at BEFORE UPDATE ON public.generated_posts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_feedback_history_updated_at BEFORE UPDATE ON public.feedback_history FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_agent_photos_updated_at BEFORE UPDATE ON public.agent_photos FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.agents (id, email, full_name)
  VALUES (NEW.id, NEW.email, NEW.raw_user_meta_data ->> 'full_name')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();