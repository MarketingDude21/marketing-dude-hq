import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

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
    question:
      "Describe yourself in a few words — not professionally, just as a person.",
    nudge: "How would your closest friends describe you at dinner?",
  },
  {
    section: "Who you are",
    question:
      "What kind of humor do you have? Sarcastic? Dry? Self-deprecating? Dad jokes?",
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
    question:
      "What do you say all the time — phrases that just come out automatically?",
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
    question:
      "Why did you get into real estate — and be honest, was it always the plan?",
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
    question:
      "Walk me through a normal day on the job — what are you actually doing between appointments?",
    nudge:
      "Previewing homes, doing paperwork at a specific coffee shop, calling clients from your car — the everyday moments worth filming, not the highlight reel.",
  },
  {
    section: "Real estate you",
    question:
      "Tell me about another client moment — a different one from before. The messier the better.",
    nudge:
      "One story runs out fast. Give me a second one — a deal that almost fell apart, a client who became a friend, anything real.",
  },
  {
    section: "Your local area",
    question:
      "What's your actual favorite spot in town — the place you'd take a friend without being asked?",
    nudge:
      "Coffee shop, trail, restaurant, anything. Not the touristy answer, the real one.",
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

// Shape stored in the agents.voice_answers jsonb column.
export type VoiceDnaAnswers = {
  answers: VoiceDnaAnswer[];
  serviceAreas: string;
};

function buildVoiceDnaPrompt(
  name: string,
  city: string,
  answers: VoiceDnaAnswer[],
): string {
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
      throw new Error(
        "Voice DNA generation isn't configured yet — add ANTHROPIC_API_KEY in Lovable Cloud → Secrets.",
      );
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
      : raw.replace(/^---\n?/, "").replace(/\n?---$/, "").trim();
    if (!profile) {
      throw new Error("Could not parse the generated profile — try again.");
    }

    return { profile };
  });
