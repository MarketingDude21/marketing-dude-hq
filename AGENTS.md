<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Admin-only data tables (agent_chat_messages, content_calendar_months, content_calendar_items, agent_drive_used_files) have RLS enabled with no policies (deny-by-default); all access goes through the service-role client in src/lib/marketing.ts. Do not add anon/authenticated policies or browser-side queries without revisiting this.
- Sweet Assist SSO lives at /api/public/sso/exchange: it verifies HMAC on the raw body, then checks nonce and rate limits in RLS-locked tables (sso_nonces, sso_rate_limits), looks up users through the service-role-only sso_find_auth_user() and returns a generateLink magic link. Why: it is a public route, so it must authenticate the caller itself and must never create users.
