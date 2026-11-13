import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireAgentAccess } from "@/lib/marketing";

// The 16-question Voice DNA interview. Ported verbatim from the standalone
// voice-dna Netlify app (marketing-dude-platform/voice-dna/index.html) so
// existing answers/profiles stay meaningful and comparable.
export type VoiceDnaQuestion = {
  section: string;
  question: string;
  nudge: string;
};

export const VOICE_DNA_QUESTIONS: VoiceDnaQuestion[] = [
  {
    section: "Who you are",
    question: "Describe yourself in a few words — not professionally, just as a person.",
    nudge: "How would your closest friends describe you at dinner?",
  },
  {
    section: "Who you are",
    question: "What kind of humor do you have? Sarcastic? Dry? Self-deprecating? Dad jokes?",
    nudge: "This shows up in your content more than anything else.",
  },
  {
    section: "How you communicate",
    question:
      "When you tell someone something important, how do you do it — straight to the point, or do you build up to it?",
    nudge: "Think about how you actually talk, not how you write an email.",
  },
  {
    section: "How you communicate",
    question: "What do you say all the time — phrases that just come out automatically?",
    nudge: "The stuff your family would tease you about.",
  },
  {
    section: "Your life",
    question: "What does your morning look like on a regular day?",
    nudge: "Early riser or night owl? Coffee dependent? Routine or chaos?",
  },
  {
    section: "Your life",
    question:
      "Tell me something real about your life right now — family, where you live, what your days actually feel like.",
    nudge: "The stuff that makes you a real person, not a profile.",
  },
  {
    section: "Real estate you",
    question: "Why did you get into real estate — and be honest, was it always the plan?",
    nudge: "The real story is always better than the polished one.",
  },
  {
    section: "Real estate you",
    question:
      "What kind of agent are you, personality-wise? The friend? The straight-shooter? The one who over-delivers?",
    nudge: "Not your value prop — your vibe with clients.",
  },
  {
    section: "Real estate you",
    question: "What's a moment with a client you'd never forget — good or bad?",
    nudge: "Something that stuck. Doesn't have to be dramatic.",
  },
  {
    section: "Real estate you",
    question: "What do you wish you could say on social that you've always held back?",
    nudge: "The hot take, the real opinion, the thing you think but never post.",
  },
  {
    section: "How you show up on camera",
    question:
      "Is there anything people always notice about you — something you wear, drive, carry, or always have with you?",
    nudge:
      "A hat, a truck, a coffee order, a dog that comes to showings — the stuff that makes you recognizable in a photo before anyone reads a caption.",
  },
  {
    section: "How you show up on camera",
    question: "Walk me through a normal day on the job — what are you actually doing between appointments?",
    nudge:
      "Previewing homes, doing paperwork at a specific coffee shop, calling clients from your car — the everyday moments worth filming, not the highlight reel.",
  },
  {
    section: "Real estate you",
    question: "Tell me about another client moment — a different one from before. The messier the better.",
    nudge:
      "One story runs out fast. Give me a second one — a deal that almost fell apart, a client who became a friend, anything real.",
  },
  {
    section: "Your local area",
    question: "What's your actual favorite spot in town — the place you'd take a friend without being asked?",
    nudge: "Coffee shop, trail, restaurant, anything. Not the touristy answer, the real one.",
  },
  {
    section: "Who you are not",
    question: "What kind of agent do you NOT want to be mistaken for?",
    nudge:
      "The pushy closer, the fake-cheerful Instagram realtor, the guy who never stops selling — who's the opposite of you?",
  },
  {
    section: "Boundaries",
    question:
      "Is there anything that should stay off-limits for your content — people, topics, or anything from your past you don't want referenced?",
    nudge:
      "Family members, old jobs, anything private. We will never post it, this just keeps us out of bounds you didn't ask for.",
  },
];

export type VoiceDnaAnswer = { question: string; answer: string };

// Added 2026-10-22 per Mike's "beneath the headshot logo section, we should
// put in the rest of their information... phone number, their website,
// their license number if applicable, their email address, and the
// address" request - see saveAgentBusinessInfo below for why these live
// here instead of new dedicated columns. Phone itself isn't in here - it
// already has its own `agents.phone` column (shared with the interview's
// own Basics step), so this only holds the fields that had nowhere else to
// go.
export type AgentBusinessInfo = {
  website: string;
  licenseNumber: string;
  email: string;
  officeAddress: string;
};

// Added 2026-11-13 per Mike: "we should also plug in their social media
// handles... Instagram, Facebook, LinkedIn, YouTube, Zillow, Trulia" —
// specifically as reference text the bio writer below can work from, not
// as something this app fetches live (see the comment on generateBrandBios
// for why). TikTok added alongside the ones Mike actually listed since this
// whole app already leans on Reels/video content and most agents using it
// will have one; easy to drop if it turns out nobody fills it in.
export type AgentSocialHandles = {
  instagram: string;
  facebook: string;
  linkedin: string;
  youtube: string;
  tiktok: string;
  zillow: string;
  trulia: string;
};

// Website Scan (2026-11-13) — per Mike, right after the bio writer/graphics
// generator shipped: "you should be able to scan their website and create
// content too... to grab other images etc, if need be, but the only thing
// you should need is headshot and logo." So this is purely additive — an
// agent who's only ever uploaded a headshot and logo still gets full bios
// and graphics (see generateBrandBios and renderBrandGraphic in voice.tsx),
// this just optionally enriches both further when the agent's own website
// is already on file (see Business Info above). Images found on the page
// are re-hosted into our own "media" Storage bucket (see scanAgentWebsite
// below) rather than linked directly — most real-world sites don't send
// CORS headers, which would silently block the browser's <canvas> from
// ever using them as a graphic background.
export type WebsiteScan = {
  scannedAt: string;
  title: string;
  description: string;
  images: string[];
  // Added same day per Mike: "when you scan their website that should give
  // you colors... give me a whole branding kit with the click of a
  // button." Pulled from the page's own <meta name="theme-color"> tag when
  // it sets one — that tag exists specifically so a browser/OS can tint its
  // own UI to match a site's brand, so it's a direct, reliable signal
  // rather than a guess (see scanAgentWebsite). Not every site sets one;
  // when it's missing, renderBrandGraphic in voice.tsx falls back to
  // sampling the agent's logo instead (extractAccentColor), same as before
  // this existed.
  brandColor: string | null;
};

// Shape stored in the agents.voice_answers jsonb column. businessInfo,
// contentBrandingStrategy, socialHandles, and websiteScan are all set
// independently of the interview's own answers/serviceAreas, via their own
// save calls below - see saveAgentVoiceProfile's merge-not-overwrite
// comment for why that matters.
export type VoiceDnaAnswers = {
  answers: VoiceDnaAnswer[];
  serviceAreas: string;
  businessInfo?: AgentBusinessInfo;
  contentBrandingStrategy?: string;
  socialHandles?: AgentSocialHandles;
  websiteScan?: WebsiteScan;
};

function buildVoiceDnaPrompt(name: string, city: string, answers: VoiceDnaAnswer[]): string {
  const qa = answers
    .map((a, i) => `Q: ${VOICE_DNA_QUESTIONS[i]?.question ?? a.question}\nA: ${a.answer || "(no answer)"}`)
    .join("\n\n");

  return `You are building a Voice DNA profile for a real estate agent. This is NOT about real estate — it is about who they are as a person.

GOAL: A profile so specific and human that content written with it could NEVER be mistaken for AI. Posts will be 1-3 sentences max. Everything should sound like they texted a friend.

Agent: ${name}, ${city}.

Interview:
${qa}

Pull DIRECTLY from their words. Generic = failure. Output ONLY between the --- markers:

---
VOICE DNA — ${name.toUpperCase()} | ${city.toUpperCase()}
Generated: ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}

WHO THEY ARE AS A PERSON:
[3-4 sentences. Specific details only. No filler.]

HOW THEY NATURALLY TALK:
[Energy, humor, sentence length, stories or straight shooter?]

THEIR HUMOR:
[Specific type with real examples from their answers.]

PHRASES THEY ACTUALLY USE:
[Verbatim phrases from their answers, each in quotes.]

VISUAL IDENTITY:
[What makes them recognizable on camera before anyone reads a caption — recurring item, vehicle, pet, habit they mentioned. If nothing specific was shared, write "Not specified yet."]

DAILY MOMENTS WORTH FILMING:
[2-4 specific everyday moments from their answers that could become content — not generic real estate b-roll, the actual things they described doing.]

WHO THEY ARE NOT:
[Pull directly from their answer about who they refuse to be mistaken for. This is as important as who they are.]

THEIR PERSONALITY IN 5 WORDS:
[Five words only.]

CONTENT VIBE:
[2-3 sentences. What should every post feel like?]

ALWAYS DO:
- [rule from their personality]
- [rule from their personality]
- [rule from their personality]
- [rule from their personality]

NEVER DO:
- No hyphens used as dashes, ever
- No AI-tell phrases: "as a real estate professional," "in the world of real estate," "I am passionate about," "navigating the market," "elevate," "unlock," "dive in," "game-changer"
- No corporate or salesy language of any kind
- [thing that feels fake for THIS person, from their answers]
- [thing that feels fake for THIS person, from their answers]

OFF-LIMITS:
[Pull directly from their boundaries answer — people, topics, or anything they said should stay private. If nothing was shared, write "Nothing specified — ask before referencing family or past jobs."]

SHORT-FORM RULES:
[How their 1-3 sentence posts should land.]

AUTHENTICITY TEST:
"Would ${name} actually text this to a friend?"
---`;
}

type GenerateVoiceDnaInput = {
  name: string;
  city: string;
  answers: VoiceDnaAnswer[];
};

type AnthropicContentBlock = { type?: string; text?: string };
type AnthropicResponse = {
  content?: AnthropicContentBlock[];
  error?: { message?: string };
};

// Server function: builds the prompt and calls Claude with the server-only
// ANTHROPIC_API_KEY secret. Gated by requireSupabaseAuth, so this can only be
// called by someone already signed into the dashboard — there is no separate
// login for this module anymore, since it's the same app, same session.
export const generateVoiceDnaProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: GenerateVoiceDnaInput) => data)
  .handler(async ({ data }): Promise<{ profile: string }> => {
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) {
      throw new Error("Voice DNA generation isn't configured yet — add ANTHROPIC_API_KEY in Lovable Cloud → Secrets.");
    }

    const prompt = buildVoiceDnaPrompt(data.name, data.city, data.answers);

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const json = (await res.json()) as AnthropicResponse;

    if (!res.ok) {
      throw new Error(json.error?.message ?? `Claude API error (${res.status})`);
    }

    const raw = (json.content ?? [])
      .map((block) => block.text ?? "")
      .join("")
      .trim();
    if (!raw) {
      throw new Error("Empty response from Claude — try again.");
    }

    const match = raw.match(/---\n([\s\S]+?)\n---/);
    const profile = match
      ? (match[1] ?? "").trim()
      : raw
          .replace(/^---\n?/, "")
          .replace(/\n?---$/, "")
          .trim();
    if (!profile) {
      throw new Error("Could not parse the generated profile — try again.");
    }

    return { profile };
  });

// ============================================================================
// Build My Brand — admin "act as agent" support + brand assets (2026-09-28)
//
// Mike, after switching to a client in Build My Database and then clicking
// Build My Brand: "it only takes me to my personal account under build my
// brand... it should be for whoever's account I'm logged into... whoever the
// admin is logged in at, that's what should appear under the build my brand
// section, unless they're logged in as themselves."
//
// Root cause: voice.tsx always read/wrote the SIGNED-IN user's own `agents`
// row directly from the browser (`supabase.from("agents")...eq("id",
// user.id)`), relying on that table's own RLS (auth.uid() = id). That RLS
// is exactly why an admin could never see or edit another agent's Voice DNA
// from the browser client no matter what UI you put in front of it — the
// database itself refuses the read/write. Monthly Marketing solved the
// identical problem months ago with its own "Change agent" picker backed by
// server functions that check access explicitly and then read/write with
// the service-role client — that's the same fix applied here, reusing
// Monthly Marketing's own access model (requireAgentAccess, imported above)
// rather than inventing a second one, since both pages already share one
// admin_allowlist + agents identity system.
//
// NOTE on scope: Build My Database's "Change client" picker is a SEPARATE
// concept from this one — it's picking a client in the entirely separate
// SOI Builder Supabase project (see soi-builder.ts's file header), which has
// no shared id with this dashboard's own `agents` table. So this is its own
// "Change agent" picker, matching the one Monthly Marketing already has —
// not a single global switch shared across every tool. Each tool remembers
// its own pick while you're in it, same as Monthly Marketing already works.
// ============================================================================

export type AgentVoiceProfile = {
  full_name: string | null;
  market_area: string | null;
  phone: string | null;
  voice_answers: VoiceDnaAnswers | null;
  voice_summary: string | null;
  headshot_url: string | null;
  logo_url: string | null;
};

// Reads the target agent's Voice DNA + brand-asset fields with the
// service-role client, after confirming the caller is either that agent
// themselves or an admin — the same boundary every Monthly Marketing action
// already enforces, just applied to the `agents` row directly instead of
// agent_photos/generated_posts.
export const getAgentVoiceProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string }) => data)
  .handler(async ({ data, context }): Promise<AgentVoiceProfile | null> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("agents")
      .select("full_name, market_area, phone, voice_answers, voice_summary, headshot_url, logo_url")
      .eq("id", data.agentId)
      .maybeSingle();
    if (error) throw error;
    if (!row) return null;
    return {
      full_name: row.full_name,
      market_area: row.market_area,
      phone: row.phone,
      voice_answers: (row.voice_answers as VoiceDnaAnswers | null) ?? null,
      voice_summary: row.voice_summary,
      headshot_url: row.headshot_url ?? null,
      logo_url: row.logo_url ?? null,
    };
  });

// Saves the target agent's basics + interview answers + generated profile.
// Same guard as the read above, re-checked fresh (never trusts a prior
// check from earlier in the session).
export const saveAgentVoiceProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (data: {
      agentId: string;
      fullName: string;
      marketArea: string;
      phone: string;
      voiceAnswers: VoiceDnaAnswers;
      voiceSummary: string;
    }) => data,
  )
  .handler(async ({ data, context }): Promise<{ ok: true } | { ok: false; error: string }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Merge rather than blindly overwrite (2026-10-22): voice_answers now
    // also carries businessInfo/contentBrandingStrategy (see the types
    // above and the two new save functions below), set independently of
    // the interview through their own save calls, any time. Finishing or
    // redoing the 16-question interview writes a fresh `answers`/
    // `serviceAreas` pair here - it must never silently wipe out business
    // info or a content branding strategy someone already filled in on
    // this same screen, which a blind overwrite of the whole column would
    // have done.
    const { data: existingRow } = await supabaseAdmin
      .from("agents")
      .select("voice_answers")
      .eq("id", data.agentId)
      .maybeSingle();
    const existing = (existingRow?.voice_answers as VoiceDnaAnswers | null) ?? null;
    const nextVoiceAnswers: VoiceDnaAnswers = {
      ...existing,
      answers: data.voiceAnswers.answers,
      serviceAreas: data.voiceAnswers.serviceAreas,
    };

    const { error } = await supabaseAdmin
      .from("agents")
      .update({
        full_name: data.fullName.trim() || null,
        market_area: data.marketArea.trim() || null,
        phone: data.phone.trim() || null,
        voice_answers: nextVoiceAnswers,
        voice_summary: data.voiceSummary,
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.agentId);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });

// Business Info — phone/website/license/email/office address (2026-10-22),
// per Mike: "beneath the headshot logo section, we should put in the rest
// of their information, where they could put their phone number, their
// website, their license number if applicable, their email address, and
// the address, like where their office location is." Independent of the
// interview entirely - same "live independent of interview stage, saved
// immediately" pattern the headshot/logo uploads already use (see
// uploadBrandAsset in voice.tsx), not gated behind finishing all 16
// questions the way the rest of voice_answers normally is.
//
// Phone reuses the existing agents.phone column the interview's own Basics
// step already writes - one canonical phone number, editable from either
// place. The other four fields have no existing column, so they go into
// voice_answers.businessInfo instead - no schema migration needed, same
// reasoning as everything else added to this column. Read-modify-write,
// since voice_answers may already hold real interview answers/service
// areas (or a content branding strategy, saved separately below) that a
// blind overwrite here would wipe out.
export const saveAgentBusinessInfo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (data: {
      agentId: string;
      phone: string;
      website: string;
      licenseNumber: string;
      email: string;
      officeAddress: string;
    }) => data,
  )
  .handler(async ({ data, context }): Promise<{ ok: true } | { ok: false; error: string }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: existingRow, error: readErr } = await supabaseAdmin
      .from("agents")
      .select("voice_answers")
      .eq("id", data.agentId)
      .maybeSingle();
    if (readErr) return { ok: false, error: readErr.message };

    const existing = (existingRow?.voice_answers as VoiceDnaAnswers | null) ?? { answers: [], serviceAreas: "" };
    const nextVoiceAnswers: VoiceDnaAnswers = {
      ...existing,
      businessInfo: {
        website: data.website.trim(),
        licenseNumber: data.licenseNumber.trim(),
        email: data.email.trim(),
        officeAddress: data.officeAddress.trim(),
      },
    };

    const { error } = await supabaseAdmin
      .from("agents")
      .update({
        phone: data.phone.trim() || null,
        voice_answers: nextVoiceAnswers,
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.agentId);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });

// Content Branding Strategy (2026-10-22) — per Mike: "once somebody is
// finished with the interview... I want to add a section... called their
// content branding strategy. This section will just have a document that I
// can upload inside of here that'll also play into their voice DNA
// profile." See withContentBrandingStrategy/withContentBrandingStrategyOptional
// in marketing.ts for exactly how this text gets woven into every place
// that builds a content-generation prompt from this agent's Voice DNA.
//
// Plain text only, by design: typed or pasted directly in the textarea, or
// auto-filled from a plain-text (.txt/.md) file the browser reads
// client-side with zero new dependencies (see handleContentStrategyFile in
// voice.tsx). A real Word/PDF upload-and-extract is a materially bigger,
// separate build - it needs an actual parsing library - so it's flagged to
// Mike as a follow-up rather than guessed at here; the textarea is always
// available either way for pasting a doc's text in by hand right now.
export const saveContentBrandingStrategy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; text: string }) => data)
  .handler(async ({ data, context }): Promise<{ ok: true } | { ok: false; error: string }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: existingRow, error: readErr } = await supabaseAdmin
      .from("agents")
      .select("voice_answers")
      .eq("id", data.agentId)
      .maybeSingle();
    if (readErr) return { ok: false, error: readErr.message };

    const existing = (existingRow?.voice_answers as VoiceDnaAnswers | null) ?? { answers: [], serviceAreas: "" };
    const nextVoiceAnswers: VoiceDnaAnswers = {
      ...existing,
      contentBrandingStrategy: data.text.trim(),
    };

    const { error } = await supabaseAdmin
      .from("agents")
      .update({ voice_answers: nextVoiceAnswers, updated_at: new Date().toISOString() })
      .eq("id", data.agentId);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });

// Social Media Handles (2026-11-13) — see AgentSocialHandles above. Same
// read-modify-write-into-voice_answers pattern as saveAgentBusinessInfo and
// saveContentBrandingStrategy; this is purely storage, generateBrandBios
// below is what actually does anything with these.
export const saveAgentSocialHandles = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (data: {
      agentId: string;
      instagram: string;
      facebook: string;
      linkedin: string;
      youtube: string;
      tiktok: string;
      zillow: string;
      trulia: string;
    }) => data,
  )
  .handler(async ({ data, context }): Promise<{ ok: true } | { ok: false; error: string }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: existingRow, error: readErr } = await supabaseAdmin
      .from("agents")
      .select("voice_answers")
      .eq("id", data.agentId)
      .maybeSingle();
    if (readErr) return { ok: false, error: readErr.message };

    const existing = (existingRow?.voice_answers as VoiceDnaAnswers | null) ?? { answers: [], serviceAreas: "" };
    const nextVoiceAnswers: VoiceDnaAnswers = {
      ...existing,
      socialHandles: {
        instagram: data.instagram.trim(),
        facebook: data.facebook.trim(),
        linkedin: data.linkedin.trim(),
        youtube: data.youtube.trim(),
        tiktok: data.tiktok.trim(),
        zillow: data.zillow.trim(),
        trulia: data.trulia.trim(),
      },
    };

    const { error } = await supabaseAdmin
      .from("agents")
      .update({ voice_answers: nextVoiceAnswers, updated_at: new Date().toISOString() })
      .eq("id", data.agentId);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });

// Scan My Website (2026-11-13) — see WebsiteScan above for why this exists.
// Server-side only (never fetched from the browser): the site being scanned
// is a third party from the browser's point of view, so a client-side fetch
// would just hit CORS and fail for most sites anyway, and a server function
// is also where API keys/secrets stay out of the client bundle, same reason
// every Claude call in this file already runs server-side.
//
// Deliberately simple — no HTML-parsing library pulled in (nothing in this
// repo already does that), just a handful of targeted regexes against the
// raw HTML for <title>, the meta description, and image URLs (og:image
// first, then a handful of <img src> tags). This is this agent's OWN site,
// scanned at their own request for their own content — a materially
// different call than the "should we scrape Instagram/Facebook/etc." one
// flagged on generateBrandBios above, where the platform's own ToS is what
// rules scraping out.
//
// Found images are downloaded here (server-side, so no CORS concern on the
// read) and re-uploaded into the same "media" Storage bucket brand assets
// already use, under this agent's own `${agentId}/brand/website-scan/`
// prefix — never linked to directly. Most real business sites don't send
// Access-Control-Allow-Origin headers, and the <canvas> compositor in
// voice.tsx (renderBrandGraphic) needs crossOrigin="anonymous" to export
// anything it draws; without re-hosting, a background photo picked here
// would just silently fail to load there. One bad image (fails to
// download, isn't actually an image, etc.) is skipped rather than failing
// the whole scan — this is a best-effort enrichment, not a hard dependency.
export const scanAgentWebsite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string }) => data)
  .handler(async ({ data, context }): Promise<({ ok: true } & WebsiteScan) | { ok: false; error: string }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: existingRow, error: readErr } = await supabaseAdmin
      .from("agents")
      .select("voice_answers")
      .eq("id", data.agentId)
      .maybeSingle();
    if (readErr) return { ok: false, error: readErr.message };

    const existing = (existingRow?.voice_answers as VoiceDnaAnswers | null) ?? { answers: [], serviceAreas: "" };
    const rawWebsite = existing.businessInfo?.website?.trim();
    if (!rawWebsite) {
      return { ok: false, error: "Add a website in Business Info above and save it first." };
    }
    const baseUrl = /^https?:\/\//i.test(rawWebsite) ? rawWebsite : `https://${rawWebsite}`;

    async function fetchWithTimeout(url: string, timeoutMs: number, extraHeaders?: Record<string, string>) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, {
          signal: controller.signal,
          redirect: "follow",
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; YourMarketingDudeBot/1.0; +https://yourmarketingdude.com)",
            ...extraHeaders,
          },
        });
      } finally {
        clearTimeout(timer);
      }
    }

    let html: string;
    let finalUrl: string;
    try {
      const res = await fetchWithTimeout(baseUrl, 8000);
      if (!res.ok) return { ok: false, error: `Couldn't reach that site (${res.status}).` };
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("html")) return { ok: false, error: "That website didn't return a normal web page." };
      finalUrl = res.url || baseUrl;
      const fullText = await res.text();
      html = fullText.slice(0, 600_000); // cap — plenty for head/meta tags and the first screenful of images
    } catch {
      return { ok: false, error: "Couldn't reach that site — double check the URL in Business Info." };
    }

    function decodeEntities(s: string): string {
      return s
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&nbsp;/g, " ")
        .trim();
    }

    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i);
    const title = decodeEntities(ogTitleMatch?.[1] || titleMatch?.[1] || "");

    const descMatch =
      html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ||
      html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i);
    const description = decodeEntities(descMatch?.[1] || "").slice(0, 600);

    const ogImageMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*)["']/i);

    // theme-color's content/name attributes can appear in either order in
    // real-world markup, so two passes rather than assuming name comes first.
    const themeColorMatch =
      html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']*)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']theme-color["']/i);
    const rawThemeColor = themeColorMatch?.[1]?.trim() ?? "";
    const brandColor = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(rawThemeColor) ? rawThemeColor.toLowerCase() : null;

    const SKIP_PATTERN = /logo|icon|sprite|pixel|favicon|spacer|blank|placeholder|avatar/i;
    const candidateUrls: string[] = [];
    if (ogImageMatch?.[1]) candidateUrls.push(ogImageMatch[1]);
    const imgTagRe = /<img[^>]+src=["']([^"']+)["']/gi;
    let m: RegExpExecArray | null;
    while ((m = imgTagRe.exec(html)) && candidateUrls.length < 14) {
      const src = m[1]!;
      if (src.startsWith("data:")) continue;
      if (SKIP_PATTERN.test(src)) continue;
      if (!/\.(jpe?g|png|webp)(\?|$)/i.test(src) && !src.includes("?")) continue;
      candidateUrls.push(src);
    }

    // Resolve to absolute URLs and dedupe, keeping first-seen order (og:image
    // stays first since it was pushed in before the <img> scan).
    const seen = new Set<string>();
    const absoluteUrls: string[] = [];
    for (const u of candidateUrls) {
      try {
        const abs = new URL(u, finalUrl).toString();
        if (!seen.has(abs)) {
          seen.add(abs);
          absoluteUrls.push(abs);
        }
      } catch {
        // not a parseable URL — skip it
      }
    }

    // Download + re-upload up to 6 candidates server-side, so the browser
    // <canvas> never has to load a cross-origin image directly (see the
    // comment above this function for why). Best-effort: a failure on any
    // one candidate just means it's skipped, not that the scan fails.
    const images: string[] = [];
    for (const url of absoluteUrls) {
      if (images.length >= 6) break;
      try {
        const imgRes = await fetchWithTimeout(url, 6000);
        if (!imgRes.ok) continue;
        const contentType = imgRes.headers.get("content-type") ?? "";
        if (!contentType.startsWith("image/")) continue;
        const buf = Buffer.from(await imgRes.arrayBuffer());
        if (buf.byteLength < 4000 || buf.byteLength > 8_000_000) continue; // too small = icon/tracking pixel, too big = skip
        const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
        const path = `${data.agentId}/brand/website-scan/${crypto.randomUUID()}.${ext}`;
        const { error: uploadErr } = await supabaseAdmin.storage
          .from("media")
          .upload(path, buf, { contentType, upsert: true });
        if (uploadErr) continue;
        const { data: pub } = supabaseAdmin.storage.from("media").getPublicUrl(path);
        images.push(pub.publicUrl);
      } catch {
        continue;
      }
    }

    const scan: WebsiteScan = { scannedAt: new Date().toISOString(), title, description, images, brandColor };
    const nextVoiceAnswers: VoiceDnaAnswers = { ...existing, websiteScan: scan };
    const { error: writeErr } = await supabaseAdmin
      .from("agents")
      .update({ voice_answers: nextVoiceAnswers, updated_at: new Date().toISOString() })
      .eq("id", data.agentId);
    if (writeErr) return { ok: false, error: writeErr.message };

    return { ok: true, ...scan };
  });

// Brand Bio Writer (2026-11-13) — per Mike: "we need to create a done-for-
// you bio section that can be created just based on what they've already
// created in that section... Instagram header with the link and emojis...
// the introduction for your Facebook profile settings... the about page
// for your website, your LinkedIn profile, your Zillow profile... rate it
// by how do you want to be, professional, personable, funny, relatable."
//
// Deliberately does NOT attempt to fetch/scrape the agent's actual
// Instagram/Facebook/LinkedIn/Zillow/Trulia pages live — asked Mike about
// this directly, since none of those platforms offer a public API for this
// and scraping them is both fragile (breaks on any markup change) and
// against most of their terms of service. His call: "you know what my
// goals are, put a marketing dude in their pocket" — so this uses
// everything already captured about the agent (Voice DNA, business info,
// the social handles/links themselves as reference text, any content
// branding strategy) as the raw material instead, same as every other
// content-generation call in this app already does.
export type BrandBioResult = {
  instagram: string;
  facebook: string;
  linkedin: string;
  realtorProfile: string;
  websiteAbout: string;
};

export type BrandBioTone = "professional" | "personable" | "funny" | "relatable";

const BRAND_BIO_TONE_DESCRIPTIONS: Record<BrandBioTone, string> = {
  professional: "Polished and credible, minimal flourishes, still warm — never stiff or corporate.",
  personable: "Warm, approachable, first-person and conversational — like introducing yourself to a new neighbor.",
  funny: "Playful, a little witty or self-deprecating, personality-forward — still trustworthy, never a joke account.",
  relatable:
    "Down-to-earth and real, like a text from a friend who happens to sell real estate — nothing that sounds rehearsed.",
};

function buildBrandBioPrompt(opts: {
  name: string;
  city: string;
  phone: string;
  businessInfo: AgentBusinessInfo | undefined;
  socialHandles: AgentSocialHandles | undefined;
  voiceSummary: string | null;
  contentBrandingStrategy: string | undefined;
  websiteScan: WebsiteScan | undefined;
  tone: BrandBioTone;
  extraNotes: string;
}): string {
  const bi = opts.businessInfo;
  const sh = opts.socialHandles;
  const contact =
    `Phone: ${opts.phone || "(not given)"}\n` +
    `Website: ${bi?.website || "(not given)"}\n` +
    `Email: ${bi?.email || "(not given)"}\n` +
    `License: ${bi?.licenseNumber || "(not given)"}`;
  const handles =
    `Instagram: ${sh?.instagram || "(not given)"}\n` +
    `Facebook: ${sh?.facebook || "(not given)"}\n` +
    `LinkedIn: ${sh?.linkedin || "(not given)"}\n` +
    `YouTube: ${sh?.youtube || "(not given)"}\n` +
    `TikTok: ${sh?.tiktok || "(not given)"}\n` +
    `Zillow: ${sh?.zillow || "(not given)"}\n` +
    `Trulia: ${sh?.trulia || "(not given)"}`;

  return `You are writing branding bio copy for a real estate agent — their own "about me" text, reused wherever they need to introduce themselves. This is NOT a social media post or caption.

Agent: ${opts.name}, serving ${opts.city || "their local market"}.

CONTACT:
${contact}

SOCIAL HANDLES/LINKS (reference only — weave the relevant ones in naturally where a platform calls for it, don't just list them):
${handles}

VOICE DNA:
${opts.voiceSummary ?? "Warm, authentic, conversational. Sounds like a real person, not a real estate agent."}

${opts.contentBrandingStrategy ? `BRAND/CONTENT STRATEGY NOTES:\n${opts.contentBrandingStrategy}\n\n` : ""}${
    opts.websiteScan?.title || opts.websiteScan?.description
      ? `FROM THEIR OWN WEBSITE (scanned automatically, reference only — real specifics to draw from, not something to quote verbatim):\nTitle: ${opts.websiteScan.title || "(none)"}\nDescription: ${opts.websiteScan.description || "(none)"}\n\n`
      : ""
  }TONE REQUESTED: ${BRAND_BIO_TONE_DESCRIPTIONS[opts.tone]}

${opts.extraNotes.trim() ? `ADDITIONAL NOTES FROM THE AGENT:\n${opts.extraNotes.trim()}\n\n` : ""}Write 5 distinct bios below, each written for exactly where it will be used — don't write one generic bio and repeat it. Pull from the Voice DNA so every version still sounds like THIS specific person. NEVER use real-estate-agent clichés: no "passionate about," "navigating the market," "your trusted advisor," "dedicated to excellence," or similar. No hyphens used as dashes. First person throughout.

Output ONLY in this exact format, nothing before or after:

INSTAGRAM:
[Under 150 characters total — Instagram enforces this as a hard limit. Punchy, can use relevant emojis, line breaks are fine, end pointing at their link or a DM. Not full sentences — bio-style fragments are fine.]

FACEBOOK:
[2-3 sentences for Facebook's "Intro" field on their profile. Warm, personable, first person.]

LINKEDIN:
[A professional "About" summary, 4-6 sentences, first person. More polished than the others but still unmistakably this specific person, never corporate boilerplate.]

REALTOR PROFILE:
[For Zillow/Trulia/Realtor.com-style public agent profiles. Consumer-facing and trust-building, 3-5 sentences, first person, mentions their market area and what makes working with them worth it.]

WEBSITE ABOUT:
[The longest one — 2-3 short paragraphs for their website's About page or a YouTube channel description. Tells a real story, not just a credentials list, first person.]`;
}

export const generateBrandBios = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; tone: BrandBioTone; extraNotes: string }) => data)
  .handler(async ({ data, context }): Promise<BrandBioResult> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) {
      throw new Error("Bio generation isn't configured yet — add ANTHROPIC_API_KEY in Lovable Cloud → Secrets.");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("agents")
      .select("full_name, market_area, phone, voice_answers, voice_summary")
      .eq("id", data.agentId)
      .maybeSingle();
    if (error) throw error;
    if (!row) throw new Error("Couldn't find this agent.");

    const voiceAnswers = (row.voice_answers as VoiceDnaAnswers | null) ?? null;
    const prompt = buildBrandBioPrompt({
      name: row.full_name ?? "this agent",
      city: row.market_area ?? "",
      phone: row.phone ?? "",
      businessInfo: voiceAnswers?.businessInfo,
      socialHandles: voiceAnswers?.socialHandles,
      voiceSummary: row.voice_summary,
      contentBrandingStrategy: voiceAnswers?.contentBrandingStrategy,
      websiteScan: voiceAnswers?.websiteScan,
      tone: data.tone,
      extraNotes: data.extraNotes,
    });

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const json = (await res.json()) as AnthropicResponse;
    if (!res.ok) {
      throw new Error(json.error?.message ?? `Claude API error (${res.status})`);
    }
    const raw = (json.content ?? [])
      .map((block) => block.text ?? "")
      .join("")
      .trim();
    if (!raw) throw new Error("Empty response from Claude — try again.");

    // Pulls each labeled section out in order, each one running until the
    // next known label (or end of string) — same idea as the DESCRIPTION/
    // POST/TEXT OVERLAYS parsing marketing.ts already uses for photo scans,
    // just with 5 labels instead of 3.
    function section(label: string, nextLabels: string[]): string {
      const stopPattern = nextLabels.length ? `(?:\\n(?:${nextLabels.join("|")}):|$)` : "$";
      const re = new RegExp(`${label}:\\s*\\n([\\s\\S]*?)${stopPattern}`, "i");
      const match = raw.match(re);
      return (match?.[1] ?? "").trim();
    }

    const result: BrandBioResult = {
      instagram: section("INSTAGRAM", ["FACEBOOK", "LINKEDIN", "REALTOR PROFILE", "WEBSITE ABOUT"]),
      facebook: section("FACEBOOK", ["LINKEDIN", "REALTOR PROFILE", "WEBSITE ABOUT"]),
      linkedin: section("LINKEDIN", ["REALTOR PROFILE", "WEBSITE ABOUT"]),
      realtorProfile: section("REALTOR PROFILE", ["WEBSITE ABOUT"]),
      websiteAbout: section("WEBSITE ABOUT", []),
    };
    if (!result.instagram && !result.facebook && !result.linkedin && !result.realtorProfile && !result.websiteAbout) {
      throw new Error("Could not parse the generated bios — try again.");
    }
    return result;
  });

// Branding Graphics v2 — real AI image generation (2026-11-13). The first
// version of this (see renderBrandGraphic, formerly in voice.tsx) drew
// shapes on a <canvas> by hand: a circle, a gradient, some text. Mike's
// reaction, after sending 3 examples of real polished agent banners: "worst
// cover photo ever I literally gave you examples... This is why you need
// to scan the website and come up with some cool shit... use all your
// resources... pretend you are [a graphic designer] and make marketing
// dude look awesome." He's right that hand-drawn shapes were never going
// to compete with an actually-designed banner — so this replaces that
// approach entirely with a real text-to-image model (OpenAI's gpt-image-1,
// the same model behind image generation in ChatGPT, which he explicitly
// pointed at) doing actual design work from a detailed art-directed prompt,
// given the agent's real headshot, logo, scanned website photo, and brand
// color as reference images. Needs an OPENAI_API_KEY secret in Lovable
// Cloud — same setup as the existing ANTHROPIC_API_KEY, just a different
// provider since Claude's own API is text-only and has no image model.
//
// One generation call returns one landscape "master" image; voice.tsx then
// crops that same image into the exact YouTube banner and Facebook cover
// pixel dimensions client-side (cheap, free, no second API call) — see
// cropMasterGraphic there. That's also why the prompt below explicitly asks
// the model to keep the headshot and all text inside the vertical-center
// band of the frame: a Facebook cover is a much shorter/wider strip than
// the model can generate directly, so the top and bottom have to be safe
// to crop away.
export type BrandGraphicTemplate = "bold-split" | "photo-backdrop" | "centered-minimal";

const BRAND_GRAPHIC_TEMPLATE_BRIEFS: Record<BrandGraphicTemplate, string> = {
  "bold-split":
    "STYLE: Bold modern editorial. Deep, rich dark background in the brand color (moody gradient, subtle diagonal light streak or soft geometric shapes for depth — never flat/empty). The headshot sits in a clean circular frame with a thin glowing ring in a light accent color, positioned left-of-center. Large, confident, bold condensed sans-serif typography for the name, in white, immediately to the right of the headshot. A thinner, lighter-weight tagline line beneath the name. This should feel like a premium real estate brand's YouTube channel art — polished, a little dramatic, unmistakably professional.",
  "photo-backdrop":
    "STYLE: Lifestyle photo backdrop. Use the provided website photo as a full-bleed background, subtly darkened/color-graded toward the brand color with a soft gradient overlay so text stays perfectly legible — never leave it bright/uncolored, and never leave text low-contrast. The headshot sits in a clean white-bordered circular badge, with the name and tagline in a semi-opaque rounded card/panel so they read clearly over the photo. This should feel like a real, published real estate team's cover photo — warm, inviting, true to their actual business, not a stock-photo collage.",
  "centered-minimal":
    "STYLE: Clean minimal centered. Soft, airy, light background in a gentle tint of the brand color (think warm cream, soft sage, or pale sand depending on the brand color given — never stark white, never a hard gradient). Headshot centered in a clean circular frame with a soft drop shadow. Name centered beneath it in confident, elegant typography (a refined serif or a clean bold sans — designer's choice), tagline centered below that in a lighter weight. Tasteful, generous whitespace. This should feel like a boutique brokerage's polished About page hero image.",
};

function buildBrandGraphicPrompt(opts: {
  name: string;
  tagline: string;
  phone: string;
  website: string;
  email: string;
  licenseNumber: string;
  brandColorHex: string | null;
  template: BrandGraphicTemplate;
  hasLogo: boolean;
  hasBackgroundPhoto: boolean;
}): string {
  const contactParts = [opts.phone, opts.website, opts.email].map((s) => s.trim()).filter(Boolean);
  const contactLine = contactParts.join("   •   ");

  return `You are a senior graphic designer creating a professional real estate marketing banner (usable as both a YouTube channel banner and a Facebook cover photo) for a real estate agent. Output a single polished, high-end, realistic marketing graphic — not a mockup, not a collage, not a template with placeholder-looking text. This needs to look like it came out of a real design agency.

${BRAND_GRAPHIC_TEMPLATE_BRIEFS[opts.template]}

${opts.brandColorHex ? `BRAND COLOR: Build the entire palette around ${opts.brandColorHex} — this is this agent's real brand color, pulled from their own website. Use it with confidence, not as a token accent.` : "BRAND COLOR: No brand color was given — choose a sophisticated, trustworthy palette (deep navy, warm charcoal, or an editorial green/teal all work well for real estate) and commit to it fully."}

IMAGES PROVIDED: The first image is this agent's real headshot — use their actual likeness, cropped into the circular frame described above, do not alter their face or replace it with a generic person.${opts.hasLogo ? " The second image is their company/team logo — place it tastefully and small in a corner (top or bottom), preserving its exact design, never redrawn or altered." : ""}${
    opts.hasBackgroundPhoto
      ? ` The ${opts.hasLogo ? "third" : "second"} image is a real photo from this agent's own website. ${
          opts.template === "photo-backdrop"
            ? "Use it exactly as instructed in the style brief above (as the full background)."
            : "Do not place it literally in the design — use only its colors, lighting, and mood as inspiration for the background palette."
        }`
      : ""
  }

TEXT TO RENDER (exact spelling, bold and perfectly legible, real typography — not garbled or approximated):
Name: "${opts.name}"
Tagline: "${opts.tagline}"
${contactLine ? `Contact line (small, in a clean row, can include simple minimal icons): "${contactLine}"` : ""}
${opts.licenseNumber.trim() ? `License line (small, subtle): "License #${opts.licenseNumber.trim()}"` : ""}

CRITICAL COMPOSITION CONSTRAINT: This image will be cropped to several different wide aspect ratios afterward (some much shorter/wider than this canvas). Keep the headshot and ALL text — name, tagline, contact line, license — vertically centered within the middle 50% of the frame, with generous, visually intentional (not empty-looking) background extending to the very top and bottom edges. Nothing essential can be near the top or bottom edge.

Landscape orientation. No watermarks, no stock-photo text, no placeholder text of any kind.`;
}

async function fetchAsBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't load one of your brand images (${res.status}).`);
  return res.blob();
}

export const generateBrandGraphicAI = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (data: { agentId: string; template: BrandGraphicTemplate; tagline: string; backgroundImageUrl: string | null }) =>
      data,
  )
  .handler(async ({ data, context }): Promise<{ imageUrl: string }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const apiKey = process.env["OPENAI_API_KEY"];
    if (!apiKey) {
      throw new Error(
        "Branding Graphics needs an OPENAI_API_KEY secret — add it in Lovable Cloud → Secrets, then try again.",
      );
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("agents")
      .select("full_name, phone, headshot_url, logo_url, voice_answers")
      .eq("id", data.agentId)
      .maybeSingle();
    if (error) throw error;
    if (!row) throw new Error("Couldn't find this agent.");
    if (!row.headshot_url) throw new Error("Upload a headshot above first — these are built from it.");

    const voiceAnswers = (row.voice_answers as VoiceDnaAnswers | null) ?? null;
    const bi = voiceAnswers?.businessInfo;

    const prompt = buildBrandGraphicPrompt({
      name: row.full_name ?? "Your Name",
      tagline: data.tagline.trim() || "Real Estate Agent",
      phone: row.phone ?? "",
      website: bi?.website ?? "",
      email: bi?.email ?? "",
      licenseNumber: bi?.licenseNumber ?? "",
      brandColorHex: voiceAnswers?.websiteScan?.brandColor ?? null,
      template: data.template,
      hasLogo: Boolean(row.logo_url),
      hasBackgroundPhoto: Boolean(data.backgroundImageUrl),
    });

    const formData = new FormData();
    formData.append("model", "gpt-image-1");
    formData.append("prompt", prompt);
    formData.append("size", "1536x1024");
    // "high" over the cheaper/faster options — this is specifically about
    // rendering a name, tagline, and contact info accurately and legibly,
    // and lower quality settings on this model noticeably hurt text
    // fidelity. Worth the extra cost/latency for something an agent will
    // actually publish.
    formData.append("quality", "high");
    formData.append("image[]", await fetchAsBlob(row.headshot_url), "headshot.png");
    if (row.logo_url) formData.append("image[]", await fetchAsBlob(row.logo_url), "logo.png");
    if (data.backgroundImageUrl)
      formData.append("image[]", await fetchAsBlob(data.backgroundImageUrl), "background.png");

    const res = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });
    const json = (await res.json()) as { data?: { b64_json?: string }[]; error?: { message?: string } };
    if (!res.ok) {
      throw new Error(json.error?.message ?? `Image generation failed (${res.status}).`);
    }
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) throw new Error("Image generation returned nothing usable — try again.");

    const buf = Buffer.from(b64, "base64");
    const path = `${data.agentId}/brand/ai-graphics/${crypto.randomUUID()}.png`;
    const { error: uploadErr } = await supabaseAdmin.storage
      .from("media")
      .upload(path, buf, { contentType: "image/png", upsert: true });
    if (uploadErr) throw uploadErr;
    const { data: pub } = supabaseAdmin.storage.from("media").getPublicUrl(path);
    return { imageUrl: pub.publicUrl };
  });

// Brand assets — headshot + logo (2026-09-28). Mike: "they should also be
// able to upload their headshots and logos to this section... their
// headshot and logos would give us like their brand colors and everything
// else we need for anything marketing going forward." Built now: upload +
// storage + display.
//
// The bio builder and the YouTube/Facebook graphics generator Mike flagged
// as "eventually" additions here are now built too — see generateBrandBios
// above (bios) and renderBrandGraphic in voice.tsx (the client-side canvas
// compositor behind the banner/cover generator, built the same way
// marketing.tsx's photo text-overlay tool composites text onto a photo —
// no new server function needed for that half at all).
//
// Same two-step signed-upload-URL pattern Monthly Marketing's Media tab
// already uses (createMediaUploadUrl/finalizeMediaUpload in marketing.ts) —
// the browser uploads bytes straight to Storage, this never proxies the
// file itself. The only difference: a headshot/logo is a single replaceable
// slot per agent (stored directly on the agents row), not a gallery item
// (agent_photos), so "finalize" here updates agents.headshot_url/logo_url
// instead of inserting a new agent_photos row — uploading a new one simply
// overwrites the old URL, matching "replace my headshot" being the only
// thing that makes sense for a single profile photo/logo slot.
export const createBrandAssetUploadUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; fileName: string; kind: "headshot" | "logo" }) => data)
  .handler(async ({ data, context }): Promise<{ path: string; token: string }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const safeName = data.fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120);
    const path = `${data.agentId}/brand/${data.kind}-${crypto.randomUUID()}-${safeName}`;
    const { data: signed, error } = await supabaseAdmin.storage.from("media").createSignedUploadUrl(path);
    if (error) throw error;
    return { path, token: signed.token };
  });

export const finalizeBrandAssetUpload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { agentId: string; storagePath: string; kind: "headshot" | "logo" }) => data)
  .handler(async ({ data, context }): Promise<{ ok: true; url: string }> => {
    const email = (context.claims as { email?: string } | undefined)?.email;
    await requireAgentAccess(context.userId, email, data.agentId);
    if (!data.storagePath.startsWith(`${data.agentId}/brand/`)) {
      throw new Error("Upload path does not belong to this agent.");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: pub } = supabaseAdmin.storage.from("media").getPublicUrl(data.storagePath);
    // Explicit branches rather than a computed { [column]: ... } key — the
    // computed form widens to a generic string index signature and doesn't
    // type-check against the generated Update type.
    const updatePayload =
      data.kind === "headshot"
        ? { headshot_url: pub.publicUrl, updated_at: new Date().toISOString() }
        : { logo_url: pub.publicUrl, updated_at: new Date().toISOString() };
    const { error } = await supabaseAdmin.from("agents").update(updatePayload).eq("id", data.agentId);
    if (error) throw error;
    return { ok: true, url: pub.publicUrl };
  });
