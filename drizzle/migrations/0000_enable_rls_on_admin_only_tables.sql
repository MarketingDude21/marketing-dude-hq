-- Security hardening (2026-10-12): these four tables hold per-agent data
-- (chat messages with the marketing assistant, content calendar months and
-- items, Drive photo usage tracking) but are only ever touched through the
-- server-side service-role client, which bypasses RLS by design. Enable RLS
-- with deny-by-default so no browser session (anon or authenticated) can read
-- or write them directly through the Data API; the server functions that
-- already own all access keep working unchanged.

ALTER TABLE public.agent_chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_drive_used_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_calendar_months ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_calendar_items ENABLE ROW LEVEL SECURITY;

GRANT ALL ON public.agent_chat_messages TO service_role;
GRANT ALL ON public.agent_drive_used_files TO service_role;
GRANT ALL ON public.content_calendar_months TO service_role;
GRANT ALL ON public.content_calendar_items TO service_role;