import { useState, type FormEvent } from "react";
import { api, type AuthPlayer } from "../api";
import { PolicyFooter } from "./PolicyPages";

export function AuthFlow({ onAuthenticated }: { onAuthenticated: (player: AuthPlayer) => void }) {
  const [step, setStep] = useState<"email" | "verify">("email");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [delivery, setDelivery] = useState<"mock" | "email">("mock");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const requestOtp = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api.requestOtp(email);
      setChallengeId(result.challengeId);
      setDelivery(result.delivery);
      setStep("verify");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not request an OTP.");
    } finally {
      setBusy(false);
    }
  };

  const verifyOtp = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api.verifyOtp(challengeId, code, displayName);
      onAuthenticated(result.player);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not verify the OTP.");
    } finally {
      setBusy(false);
    }
  };

  return <main id="main-content" className="auth-shell">
    <section className="auth-hero" aria-labelledby="welcome-title">
      <span className="eyebrow">The 3 · 21 · 27 card game</span>
      <h1 id="welcome-title">Find your 21.</h1>
      <p>Group your cards by one suit or all-different suits. Every meld must total a multiple of three—and every winning declaration needs a natural 21 with no joker or wild card.</p>
      <dl className="trinity-rule-signature" aria-label="Trinity scoring essentials">
        <div><dt>3+</dt><dd><strong>Build a meld</strong><span>At least 3 cards, totaling a multiple of 3</span></dd></div>
        <div><dt>21</dt><dd><strong>Find the Trinity</strong><span>Natural cards only—no joker or wild</span></dd></div>
        <div><dt>27</dt><dd><strong>Know the ceiling</strong><span>The highest valid meld total</span></dd></div>
      </dl>
      <ul className="feature-list" aria-label="Game features">
        <li>2 or 6 player tables</li>
        <li>Ranked public matches</li>
        <li>Invite-only private tables</li>
      </ul>
    </section>
    <section className="auth-card" aria-labelledby="auth-title">
      <div className="brand-mark" aria-hidden="true">TM</div>
      {step === "email" ? <>
        <h2 id="auth-title">Enter the club</h2>
        <p className="muted">Sign in securely with a one-time code sent to your email.</p>
        <form onSubmit={requestOtp}>
          <label htmlFor="display-name">Display name</label>
          <input id="display-name" autoComplete="nickname" minLength={2} maxLength={24} required value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          <label htmlFor="email">Email address</label>
          <input id="email" type="email" autoComplete="email" maxLength={254} required value={email} onChange={(event) => setEmail(event.target.value)} />
          <button className="primary" disabled={busy}>{busy ? "Sending…" : "Send verification code"}</button>
        </form>
      </> : <>
        <h2 id="auth-title">Check your email</h2>
        <p className="muted">{delivery === "mock"
          ? <>Local email delivery is mocked. Use <strong>123456</strong>.</>
          : <>We sent a six-digit code to <strong>{email}</strong>. It expires in five minutes.</>}</p>
        <form onSubmit={verifyOtp}>
          <label htmlFor="otp">Six-digit OTP</label>
          <input id="otp" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required autoFocus value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} />
          <button className="primary" disabled={busy}>{busy ? "Verifying…" : "Continue to lobby"}</button>
          <button className="text-button" type="button" onClick={() => { setStep("email"); setCode(""); setError(""); }}>Use another email</button>
        </form>
      </>}
      <p className="form-error" role="alert">{error}</p>
      <p className="auth-policy-note">By continuing, you agree to the <a href="/terms">Terms of Service</a> and acknowledge the <a href="/privacy">Privacy Policy</a>. You must be 18 or older.</p>
      <PolicyFooter compact />
    </section>
  </main>;
}
