"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Real Cognito sign-up (components/signup-form.tsx). A two-step flow backed by
 * the server /api/auth route (which calls Amazon Cognito; no secret in the
 * browser): (1) create the account, then (2) confirm the emailed 6-digit code.
 * On confirmation it signs in and routes to /account. All controls reuse the
 * existing auth/surface/field/cta/notice classes - no new token or class.
 */

type Step = "form" | "confirm" | "done";

async function post(body: Record<string, unknown>) {
  const res = await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return (await res.json()) as { ok: boolean; code: string; message: string };
}

export default function SignupForm() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("form");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function submitSignup(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(""); setNotice(""); setBusy(true);
    try {
      const r = await post({ action: "signup", email, password, name });
      if (r.ok && r.code === "CONFIRM_REQUIRED") { setStep("confirm"); setNotice(r.message); }
      else setError(r.message);
    } catch { setError("Network error. Please try again."); }
    finally { setBusy(false); }
  }

  async function submitConfirm(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(""); setNotice(""); setBusy(true);
    try {
      const r = await post({ action: "confirm", email, code });
      if (r.ok) {
        // Auto sign-in after confirmation, then land on the account page.
        const s = await post({ action: "signin", email, password });
        setStep("done");
        setNotice(s.ok ? "You're signed in. Redirecting..." : "Email confirmed. Please sign in.");
        window.setTimeout(() => router.push("/account"), 1200);
      } else setError(r.message);
    } catch { setError("Network error. Please try again."); }
    finally { setBusy(false); }
  }

  async function resend() {
    if (busy) return;
    setError(""); setNotice(""); setBusy(true);
    try { const r = await post({ action: "resend", email }); r.ok ? setNotice(r.message) : setError(r.message); }
    catch { setError("Network error. Please try again."); }
    finally { setBusy(false); }
  }


  return (
    <main className="shell auth auth-glass-page">
      <div className="auth-glass-page__glow" aria-hidden="true" />
      <section className="motion-rise auth__intro">
        <p className="eyebrow">Create your account</p>
        <h1 className="display">Join TripGenie</h1>
        <p className="lead">Sign up to save trips and sync across devices. We never see your password - accounts are secured by Amazon Cognito.</p>
      </section>

      <div className="auth-glass-grid auth-glass-grid--single">
        <section className="auth-glass motion-rise" aria-labelledby="signup-heading">
          <h2 id="signup-heading" className="auth__heading">{step === "confirm" ? "Confirm your email" : "Sign up"}</h2>

          {error && <p role="alert" className="notice notice--error auth__error">{error}</p>}
          {notice && <p className="notice">{notice}</p>}

          {step === "form" && (
            <form className="auth__options" onSubmit={submitSignup}>
              <label className="field"><span>Name</span>
                <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" autoComplete="name" />
              </label>
              <label className="field"><span>Email</span>
                <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
              </label>
              <label className="field"><span>Password</span>
                <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" autoComplete="new-password" />
              </label>
              <p className="auth__note">8+ characters with an uppercase, a lowercase, and a number.</p>
              <button type="submit" className="cta auth__cta" disabled={busy} aria-busy={busy}>{busy ? "Creating account..." : "Create account"}</button>
            </form>
          )}

          {step === "confirm" && (
            <form className="auth__options" onSubmit={submitConfirm}>
              <p>We emailed a 6-digit code to <strong>{email}</strong>. Enter it below to verify your account.</p>
              <label className="field"><span>Confirmation code</span>
                <input type="text" inputMode="numeric" required value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" autoComplete="one-time-code" />
              </label>
              <button type="submit" className="cta auth__cta" disabled={busy} aria-busy={busy}>{busy ? "Confirming..." : "Confirm and sign in"}</button>
              <button type="button" className="btn" onClick={resend} disabled={busy}>Resend code</button>
            </form>
          )}

          {step === "done" && (<p className="lead">{notice || "All set!"}</p>)}

          <p className="auth__note">Already have an account? <a className="inline-link" href="/account">Sign in</a>.</p>
        </section>

</div>
    </main>
  );
}

