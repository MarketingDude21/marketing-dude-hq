import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import {
  VOICE_DNA_QUESTIONS,
  generateVoiceDnaProfile,
  type VoiceDnaAnswer,
  type VoiceDnaAnswers,
} from "@/lib/voice-dna";

export const Route = createFileRoute("/voice")({
  head: () => ({
    meta: [
      { title: "My Voice DNA — Your Marketing Dude" },
      {
        name: "description",
        content: "Build the Voice DNA profile that powers every post written in your voice.",
      },
      { property: "og:title", content: "My Voice DNA — Your Marketing Dude" },
      {
        property: "og:description",
        content: "Answer 16 questions once; every post sounds like you from then on.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: VoicePage,
});

type Stage = "loading" | "intro" | "basics" | "interview" | "areas" | "generating" | "done";

type Basics = { fullName: string; marketArea: string; phone: string };
const EMPTY_BASICS: Basics = { fullName: "", marketArea: "", phone: "" };

function emptyAnswers(): string[] {
  return new Array(VOICE_DNA_QUESTIONS.length).fill("");
}

const GENERATING_MESSAGES = [
  "Reading your personality...",
  "Finding your real voice...",
  "Pulling what makes you different...",
  "Writing your Voice DNA...",
];

// Minimal ambient typing for the Web Speech API — it isn't in lib.dom.d.ts.
type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onresult: ((event: any) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: any) => void) | null;
  start: () => void;
  abort: () => void;
};

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

function isIOSDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function VoicePage() {
  const { user, loading: authLoading } = useAuth();

  const [stage, setStage] = useState<Stage>("loading");
  const [basics, setBasics] = useState<Basics>(EMPTY_BASICS);
  const [serviceAreas, setServiceAreas] = useState("");
  const [answers, setAnswers] = useState<string[]>(emptyAnswers());
  const [currentQuestion, setCurrentQuestion] = useState(0);
  const [requireAnswer, setRequireAnswer] = useState(false);

  const [profile, setProfile] = useState("");
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [genMessage, setGenMessage] = useState(GENERATING_MESSAGES[0]);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [micSupported] = useState<boolean>(() => Boolean(getSpeechRecognitionCtor()));
  const [micListening, setMicListening] = useState(false);
  const [micLabel, setMicLabel] = useState("Tap mic and speak your answer");
  const recogRef = useRef<SpeechRecognitionLike | null>(null);
  const userStoppedMicRef = useRef(false);
  const micDeniedRef = useRef(false);

  // Load whatever profile already exists for this signed-in agent.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    supabase
      .from("agents")
      .select("full_name, market_area, phone, voice_answers, voice_summary")
      .eq("id", user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        if (data) {
          setBasics({
            fullName: data.full_name ?? "",
            marketArea: data.market_area ?? "",
            phone: data.phone ?? "",
          });
          const stored = data.voice_answers as Partial<VoiceDnaAnswers> | null;
          if (stored?.answers?.length) {
            const restored = emptyAnswers();
            stored.answers.forEach((a, i) => {
              if (i < restored.length) restored[i] = a.answer ?? "";
            });
            setAnswers(restored);
          }
          if (stored?.serviceAreas) setServiceAreas(stored.serviceAreas);
          if (data.voice_summary) {
            setProfile(data.voice_summary);
            setStage("done");
            return;
          }
        }
        setStage("intro");
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Rotate the "reading your personality..." messages while generating.
  useEffect(() => {
    if (stage !== "generating") return;
    let i = 0;
    const iv = setInterval(() => {
      i = (i + 1) % GENERATING_MESSAGES.length;
      setGenMessage(GENERATING_MESSAGES[i] ?? GENERATING_MESSAGES[0]);
    }, 2200);
    return () => clearInterval(iv);
  }, [stage]);

  // Tear down the mic whenever we leave the current question.
  useEffect(() => {
    return () => {
      killMic();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentQuestion]);

  function killMic() {
    const r = recogRef.current;
    if (r) {
      r.onstart = null;
      r.onresult = null;
      r.onend = null;
      r.onerror = null;
      try {
        r.abort();
      } catch {
        // ignore
      }
      recogRef.current = null;
    }
    setMicListening(false);
  }

  function resetMicUI(msg?: string) {
    setMicListening(false);
    setMicLabel(msg ?? "Tap mic and speak your answer");
  }

  function attemptRestart(baseText: string, attemptNum: number) {
    if (userStoppedMicRef.current || micDeniedRef.current) return;
    try {
      startRecognitionInstance(baseText);
    } catch {
      if (attemptNum < 5) {
        setTimeout(() => attemptRestart(baseText, attemptNum + 1), 150 * (attemptNum + 1));
      } else {
        resetMicUI("Mic paused — tap to resume, your answer so far is saved.");
      }
    }
  }

  function startRecognitionInstance(baseTextIn: string) {
    let baseText = baseTextIn;
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    const recog = new Ctor();
    recog.continuous = !isIOSDevice();
    recog.interimResults = true;
    recog.lang = "en-US";
    let finalTranscript = "";
    const qIndex = currentQuestion;

    recog.onstart = () => {
      setMicListening(true);
      micDeniedRef.current = false;
      finalTranscript = "";
      setMicLabel("Listening... tap to stop");
    };

    recog.onresult = (e: any) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          finalTranscript += e.results[i][0].transcript + " ";
        } else {
          interim += e.results[i][0].transcript;
        }
      }
      const combined = baseText + finalTranscript + interim;
      setAnswers((prev) => {
        const next = [...prev];
        next[qIndex] = combined;
        return next;
      });
    };

    recog.onend = () => {
      setMicListening(false);
      baseText = baseText + finalTranscript;
      if (!userStoppedMicRef.current && !micDeniedRef.current) {
        attemptRestart(baseText, 0);
        return;
      }
      resetMicUI();
    };

    recog.onerror = (e: any) => {
      setMicListening(false);
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        micDeniedRef.current = true;
        userStoppedMicRef.current = true;
        resetMicUI(
          "Mic access blocked — check your browser/site settings and allow microphone access, or just type below.",
        );
        return;
      }
      if (e.error === "no-speech") return;
      if (e.error === "network") {
        resetMicUI("Network hiccup — tap the mic to try again, or type below.");
        userStoppedMicRef.current = true;
        return;
      }
      if (e.error === "aborted") return;
      resetMicUI("Error — please type your answer below.");
      userStoppedMicRef.current = true;
    };

    recogRef.current = recog;
    recog.start();
  }

  function toggleMic() {
    if (!micSupported) return;
    if (micListening) {
      userStoppedMicRef.current = true;
      killMic();
      resetMicUI();
      return;
    }
    userStoppedMicRef.current = false;
    micDeniedRef.current = false;
    killMic();
    let base = answers[currentQuestion] ?? "";
    if (base && !base.endsWith(" ")) base += " ";
    attemptRestart(base, 0);
  }

  function grabCurrentAnswer(): string {
    userStoppedMicRef.current = true;
    killMic();
    resetMicUI();
    return (answers[currentQuestion] ?? "").trim();
  }

  function goToQuestion(index: number) {
    setCurrentQuestion(index);
    setRequireAnswer(false);
  }

  function handleNext() {
    const val = grabCurrentAnswer();
    if (!val) {
      setRequireAnswer(true);
      return;
    }
    setAnswers((prev) => {
      const next = [...prev];
      next[currentQuestion] = val;
      return next;
    });
    if (currentQuestion < VOICE_DNA_QUESTIONS.length - 1) {
      goToQuestion(currentQuestion + 1);
    } else {
      setStage("areas");
    }
  }

  function handleSkip() {
    grabCurrentAnswer();
    setAnswers((prev) => {
      const next = [...prev];
      next[currentQuestion] = "(skipped)";
      return next;
    });
    if (currentQuestion < VOICE_DNA_QUESTIONS.length - 1) {
      goToQuestion(currentQuestion + 1);
    } else {
      setStage("areas");
    }
  }

  function handleBack() {
    const val = grabCurrentAnswer();
    if (val) {
      setAnswers((prev) => {
        const next = [...prev];
        next[currentQuestion] = val;
        return next;
      });
    }
    if (currentQuestion > 0) goToQuestion(currentQuestion - 1);
  }

  async function saveToSupabase(generatedProfile: string) {
    if (!user) return;
    const payload: VoiceDnaAnswers = {
      answers: VOICE_DNA_QUESTIONS.map((q, i) => ({
        question: q.question,
        answer: answers[i] ?? "",
      })),
      serviceAreas,
    };
    const { error } = await supabase
      .from("agents")
      .update({
        full_name: basics.fullName.trim() || null,
        market_area: basics.marketArea.trim() || null,
        phone: basics.phone.trim() || null,
        voice_answers: payload,
        voice_summary: generatedProfile,
        updated_at: new Date().toISOString(),
      })
      .eq("id", user.id);
    setSaveStatus(error ? `Could not save: ${error.message}` : "Saved to your profile.");
  }

  async function handleGenerate() {
    setStage("generating");
    setGenError(null);
    setGenerating(true);
    try {
      const qas: VoiceDnaAnswer[] = VOICE_DNA_QUESTIONS.map((q, i) => ({
        question: q.question,
        answer: answers[i] === "(skipped)" ? "" : (answers[i] ?? ""),
      }));
      const result = await generateVoiceDnaProfile({
        data: {
          name: basics.fullName.trim() || "the agent",
          city: basics.marketArea.trim() || "their city",
          answers: qas,
        },
      });
      setProfile(result.profile);
      await saveToSupabase(result.profile);
      setStage("done");
    } catch (e) {
      setGenError(e instanceof Error ? e.message : "Something went wrong generating your profile.");
    } finally {
      setGenerating(false);
    }
  }

  function copyProfile(id: string) {
    if (!profile) return;
    const done = () => {
      setCopiedId(id);
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 2500);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(profile)
        .then(done)
        .catch(() => {});
    }
  }

  function downloadProfile() {
    if (!profile) return;
    const name = (basics.fullName.trim() || "Agent").replace(/\s+/g, "-");
    const blob = new Blob([profile], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}-Voice-DNA.txt`;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 500);
  }

  function restart() {
    killMic();
    setAnswers(emptyAnswers());
    setProfile("");
    setGenError(null);
    setSaveStatus(null);
    setCurrentQuestion(0);
    setStage("basics");
  }

  if (!authLoading && !user) {
    return (
      <AppShell>
        <div className="mt-16 rounded-3xl border border-border bg-glass p-8 text-center backdrop-blur-2xl">
          <h1 className="font-display text-2xl font-bold">Sign in to build your Voice DNA</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Your Voice DNA profile powers every post written in your voice.
          </p>
          <Link
            to="/login"
            className="mt-6 inline-block rounded-2xl bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30"
          >
            Go to sign in
          </Link>
        </div>
      </AppShell>
    );
  }

  if (stage === "loading") {
    return (
      <AppShell>
        <div className="mt-16 text-center text-sm text-muted-foreground">Loading your profile…</div>
      </AppShell>
    );
  }

  const question = VOICE_DNA_QUESTIONS[currentQuestion] ?? VOICE_DNA_QUESTIONS[0]!;
  const progressPct = Math.round((currentQuestion / VOICE_DNA_QUESTIONS.length) * 100);

  return (
    <AppShell>
      <div className="mx-auto max-w-2xl pt-2">
        {stage === "intro" && (
          <div className="rounded-3xl border border-border bg-glass p-8 backdrop-blur-2xl">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Agent onboarding</p>
            <h1 className="mt-2 font-display text-2xl font-bold tracking-tight">
              Let's figure out who you actually are.
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              Not a real estate questionnaire. We want to know about your life and personality so every post we write
              sounds exactly like <em>you</em> — not a template.
            </p>
            <ul className="mt-6 space-y-3 text-sm text-muted-foreground">
              {[
                "Quick basics — name, city, who you work with",
                "16 questions — speak or type your answers",
                "Your Voice DNA profile is built automatically",
                "Our team uses it every month to write in your voice",
              ].map((step, i) => (
                <li key={step} className="flex items-start gap-3">
                  <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border border-border text-xs font-medium">
                    {i + 1}
                  </span>
                  {step}
                </li>
              ))}
            </ul>
            <button
              onClick={() => setStage("basics")}
              className="mt-8 rounded-2xl bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30 transition-transform hover:-translate-y-0.5"
            >
              Let's go
            </button>
          </div>
        )}

        {stage === "basics" && (
          <div className="rounded-3xl border border-border bg-glass p-8 backdrop-blur-2xl">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Step 1 of 3</p>
            <h2 className="mt-2 font-display text-xl font-bold tracking-tight">Just a few quick facts first.</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              The only boring part. Everything after this is a real conversation.
            </p>
            <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="text-sm font-medium text-muted-foreground">
                  Your name <span className="text-destructive">*</span>
                </span>
                <input
                  value={basics.fullName}
                  onChange={(e) => setBasics((b) => ({ ...b, fullName: e.target.value }))}
                  placeholder="Sarah"
                  className="mt-1.5 w-full rounded-2xl bg-muted px-4 py-3 text-sm outline-none ring-ring transition focus:ring-2"
                />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-muted-foreground">City / market</span>
                <input
                  value={basics.marketArea}
                  onChange={(e) => setBasics((b) => ({ ...b, marketArea: e.target.value }))}
                  placeholder="Austin, TX"
                  className="mt-1.5 w-full rounded-2xl bg-muted px-4 py-3 text-sm outline-none ring-ring transition focus:ring-2"
                />
              </label>
              <label className="block sm:col-span-2">
                <span className="text-sm font-medium text-muted-foreground">Phone number</span>
                <input
                  value={basics.phone}
                  onChange={(e) => setBasics((b) => ({ ...b, phone: e.target.value }))}
                  placeholder="(555) 123-4567"
                  className="mt-1.5 w-full rounded-2xl bg-muted px-4 py-3 text-sm outline-none ring-ring transition focus:ring-2"
                />
              </label>
            </div>
            {!basics.fullName.trim() && <p className="mt-3 text-xs text-destructive">Add your name to continue.</p>}
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button
                onClick={() => setStage("intro")}
                className="rounded-2xl border border-border bg-glass px-5 py-2.5 text-sm font-semibold transition-colors hover:bg-secondary"
              >
                Back
              </button>
              <button
                onClick={() => {
                  if (!basics.fullName.trim()) return;
                  setStage("interview");
                }}
                disabled={!basics.fullName.trim()}
                className="rounded-2xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30 transition-transform hover:-translate-y-0.5 disabled:opacity-40"
              >
                Start the interview
              </button>
            </div>
          </div>
        )}

        {stage === "interview" && (
          <div>
            <div className="mb-2 flex items-center gap-3">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-border">
                <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progressPct}%` }} />
              </div>
              <span className="whitespace-nowrap text-xs text-muted-foreground">
                {currentQuestion + 1} of {VOICE_DNA_QUESTIONS.length}
              </span>
            </div>
            <div className="rounded-3xl border border-border bg-glass p-8 backdrop-blur-2xl">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{question.section}</p>
              <h2 className="mt-2 font-display text-lg font-semibold leading-snug">{question.question}</h2>
              <p className="mt-1.5 text-sm italic text-muted-foreground">{question.nudge}</p>

              {micSupported && (
                <div className="mt-5 flex flex-col items-center gap-2 py-2">
                  <button
                    onClick={toggleMic}
                    className={`grid size-16 place-items-center rounded-full border transition ${
                      micListening
                        ? "animate-pulse border-destructive/40 bg-destructive/10"
                        : "border-border bg-muted hover:bg-secondary"
                    }`}
                    aria-label="Toggle voice input"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      className={`size-6 ${micListening ? "stroke-destructive" : "stroke-foreground"}`}
                      fill="none"
                      strokeWidth={1.8}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      {micListening ? (
                        <rect x="6" y="6" width="12" height="12" rx="2" />
                      ) : (
                        <>
                          <rect x="9" y="2" width="6" height="11" rx="3" />
                          <path d="M5 10a7 7 0 0 0 14 0" />
                          <line x1="12" y1="19" x2="12" y2="22" />
                          <line x1="8" y1="22" x2="16" y2="22" />
                        </>
                      )}
                    </svg>
                  </button>
                  <span
                    className={`text-xs ${micListening ? "font-medium text-destructive" : "text-muted-foreground"}`}
                  >
                    {micLabel}
                  </span>
                </div>
              )}
              {!micSupported && (
                <p className="mt-4 text-xs text-muted-foreground">
                  🎤 Voice input isn't available in this browser — no worries, just type your answer below.
                </p>
              )}

              <div className="my-4 flex items-center gap-3 text-xs text-muted-foreground">
                <div className="h-px flex-1 bg-border" />
                or type your answer
                <div className="h-px flex-1 bg-border" />
              </div>

              <textarea
                value={answers[currentQuestion] ?? ""}
                onChange={(e) =>
                  setAnswers((prev) => {
                    const next = [...prev];
                    next[currentQuestion] = e.target.value;
                    return next;
                  })
                }
                placeholder="Speak above or type here..."
                className="min-h-[100px] w-full rounded-2xl bg-muted px-4 py-3 text-sm leading-relaxed outline-none ring-ring transition focus:ring-2"
              />
              {requireAnswer && <p className="mt-2 text-xs text-destructive">Please answer or tap Skip to continue.</p>}

              <div className="mt-6 flex flex-wrap items-center gap-3">
                <button
                  onClick={handleBack}
                  disabled={currentQuestion === 0}
                  className="rounded-2xl border border-border bg-glass px-5 py-2.5 text-sm font-semibold transition-colors hover:bg-secondary disabled:opacity-40"
                >
                  Back
                </button>
                <button
                  onClick={handleNext}
                  className="rounded-2xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30 transition-transform hover:-translate-y-0.5"
                >
                  {currentQuestion === VOICE_DNA_QUESTIONS.length - 1 ? "Build my profile" : "Next"}
                </button>
                <button
                  onClick={handleSkip}
                  className="rounded-2xl px-4 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                >
                  Skip
                </button>
              </div>
            </div>
          </div>
        )}

        {stage === "areas" && (
          <div className="rounded-3xl border border-border bg-glass p-8 backdrop-blur-2xl">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Almost done</p>
            <h2 className="mt-2 font-display text-xl font-bold tracking-tight">
              Where do you want your content focused?
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Give us the cities, ZIP codes, or counties you work — this is what we'll pull local flavor and stats from
              for your posts and emails.
            </p>
            <label className="mt-5 block">
              <span className="text-sm font-medium text-muted-foreground">Cities, ZIP codes, or counties</span>
              <textarea
                value={serviceAreas}
                onChange={(e) => setServiceAreas(e.target.value)}
                placeholder="Example: Carlsbad, Oceanside, 92008, San Diego County"
                className="mt-1.5 min-h-[100px] w-full rounded-2xl bg-muted px-4 py-3 text-sm leading-relaxed outline-none ring-ring transition focus:ring-2"
              />
            </label>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button
                onClick={() => goToQuestion(VOICE_DNA_QUESTIONS.length - 1)}
                className="rounded-2xl border border-border bg-glass px-5 py-2.5 text-sm font-semibold transition-colors hover:bg-secondary"
              >
                Back
              </button>
              <button
                onClick={handleGenerate}
                className="rounded-2xl bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30 transition-transform hover:-translate-y-0.5"
              >
                Finish →
              </button>
            </div>
          </div>
        )}

        {stage === "generating" && (
          <div className="rounded-3xl border border-border bg-glass p-8 backdrop-blur-2xl">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Step 3 of 3</p>
            <h2 className="mt-2 font-display text-xl font-bold tracking-tight">Building your Voice DNA.</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Reading your answers and finding what makes you genuinely <em>you</em>.
            </p>

            {generating && !genError && (
              <div className="mt-6 flex items-center gap-3 rounded-2xl border border-border bg-background px-5 py-4 text-sm text-muted-foreground">
                <span className="flex gap-1">
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="size-1.5 animate-pulse rounded-full bg-muted-foreground"
                      style={{ animationDelay: `${i * 0.2}s` }}
                    />
                  ))}
                </span>
                {genMessage}
              </div>
            )}

            {genError && (
              <div className="mt-6 rounded-2xl border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive">
                <p className="whitespace-pre-wrap">
                  Error: {genError}
                  {"\n\n"}Your answers are saved.
                </p>
                <button
                  onClick={handleGenerate}
                  className="mt-3 rounded-2xl bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30"
                >
                  Try again
                </button>
              </div>
            )}
          </div>
        )}

        {stage === "done" && (
          <div>
            <div className="mb-4 inline-flex items-center gap-2 rounded-xl bg-[color-mix(in_oklab,var(--color-primary)_12%,transparent)] px-4 py-2 text-sm font-medium text-primary">
              Profile complete
            </div>
            <div className="rounded-3xl border border-border bg-glass backdrop-blur-2xl overflow-hidden">
              <div className="flex items-start justify-between gap-4 border-b border-border bg-background/40 px-6 py-4">
                <div>
                  <div className="font-display text-base font-semibold">
                    {basics.fullName || "Agent"}
                    {basics.marketArea ? ` — ${basics.marketArea}` : ""}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">Voice DNA Profile</div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    onClick={() => copyProfile("done")}
                    className="rounded-xl border border-border bg-glass px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-secondary"
                  >
                    {copiedId === "done" ? "Copied!" : "Copy"}
                  </button>
                  <button
                    onClick={downloadProfile}
                    className="rounded-xl border border-border bg-glass px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-secondary"
                  >
                    Download
                  </button>
                </div>
              </div>
              <pre className="max-h-[420px] overflow-y-auto whitespace-pre-wrap px-6 py-5 font-mono text-xs leading-relaxed">
                {profile}
              </pre>
            </div>
            {saveStatus && <p className="mt-3 text-xs text-muted-foreground">{saveStatus}</p>}
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button
                onClick={restart}
                className="rounded-2xl border border-border bg-glass px-5 py-2.5 text-sm font-semibold transition-colors hover:bg-secondary"
              >
                Redo the interview
              </button>
              <Link
                to="/marketing"
                className="rounded-2xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30 transition-transform hover:-translate-y-0.5"
              >
                Go to Monthly Marketing
              </Link>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
