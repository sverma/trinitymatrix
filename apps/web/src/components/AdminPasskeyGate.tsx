import { useEffect, useState, type FormEvent } from "react";
import { api, type AdminPasskeyStatus } from "../api";
import {
  authenticateAdminPasskey,
  createAdminPasskey,
  type AuthenticationOptionsJSON,
  type RegistrationOptionsJSON
} from "../passkeys";

export function AdminPasskeyGate({ onUnlocked, onLogout }: {
  onUnlocked: () => Promise<void>;
  onLogout: () => Promise<void>;
}) {
  const [status, setStatus] = useState<AdminPasskeyStatus | null>(null);
  const [deviceName, setDeviceName] = useState("");
  const [bootstrapCode, setBootstrapCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [recovering, setRecovering] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [recoveryAcknowledgementToken, setRecoveryAcknowledgementToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.adminPasskeyStatus().then(setStatus).catch((cause) => {
      setError(cause instanceof Error ? cause.message : "Could not check passkey enrollment.");
    });
  }, []);

  const authenticate = async () => {
    setError("");
    setBusy(true);
    try {
      const request = await api.adminPasskeyAuthenticationOptions();
      const response = await authenticateAdminPasskey(request.options as AuthenticationOptionsJSON);
      await api.verifyAdminPasskeyAuthentication(request.requestId, response);
      await onUnlocked();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Passkey authentication failed.");
    } finally {
      setBusy(false);
    }
  };

  const enroll = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const request = await api.adminPasskeyRegistrationOptions({
        deviceName: deviceName.trim(),
        ...(status?.configured ? { recoveryCode: recoveryCode.trim() } : { bootstrapCode })
      });
      const response = await createAdminPasskey(request.options as RegistrationOptionsJSON);
      const verified = await api.verifyAdminPasskeyRegistration(request.requestId, response);
      if (verified.recoveryCodes?.length) {
        if (!verified.recoveryAcknowledgementToken) throw new Error("Recovery-code acknowledgement is unavailable. Start again.");
        setRecoveryCodes(verified.recoveryCodes);
        setRecoveryAcknowledgementToken(verified.recoveryAcknowledgementToken);
      } else {
        await onUnlocked();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Passkey enrollment failed.");
    } finally {
      setBusy(false);
    }
  };

  const acknowledgeRecoveryCodes = async () => {
    setBusy(true);
    setError("");
    try {
      await api.acknowledgeAdminRecoveryCodes(recoveryAcknowledgementToken);
      await onUnlocked();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not acknowledge the recovery codes.");
    } finally {
      setBusy(false);
    }
  };

  if (!status) return <main id="main-content" className="loading-screen"><div className="brand-mark">TM</div><p>Checking passkey enrollment…</p>{error && <p className="form-error" role="alert">{error}</p>}</main>;

  if (recoveryCodes.length > 0) return <main id="main-content" className="auth-page"><section className="auth-panel" aria-labelledby="recovery-codes-title">
    <span className="eyebrow">Passkey enrolled</span>
    <h1 id="recovery-codes-title">Save your recovery codes</h1>
    <p>Store these one-time codes in a password manager. They will not be shown again, and each code works once to enroll a replacement passkey.</p>
    <ol className="admin-recovery-codes" aria-label="Administrator recovery codes">{recoveryCodes.map((code) => <li key={code}><code>{code}</code></li>)}</ol>
    {error && <p className="form-error" role="alert">{error}</p>}
    <button type="button" className="primary" disabled={busy} onClick={() => void acknowledgeRecoveryCodes()}>{busy ? "Confirming…" : "I stored these codes safely"}</button>
  </section></main>;

  if (status.configured && !recovering) return <main id="main-content" className="auth-page"><section className="auth-panel" aria-labelledby="admin-passkey-title">
    <span className="eyebrow">Phishing-resistant access</span>
    <h1 id="admin-passkey-title">Use your administrator passkey</h1>
    <p>Your allowlisted email is verified. Complete the device passkey check to open the administration portal for 15 minutes.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <button type="button" className="primary" disabled={busy} onClick={() => void authenticate()}>{busy ? "Checking passkey…" : "Continue with passkey"}</button>
    <button type="button" className="text-button" onClick={() => { setRecovering(true); setError(""); }}>Lost access? Use a recovery code</button>
    <button type="button" className="text-button" onClick={() => void onLogout()}>Sign in with another email</button>
  </section></main>;

  return <main id="main-content" className="auth-page"><section className="auth-panel" aria-labelledby="admin-enroll-title">
    <span className="eyebrow">{status.configured ? "Passkey recovery" : "First administrator setup"}</span>
    <h1 id="admin-enroll-title">{status.configured ? "Enroll a replacement passkey" : "Create your administrator passkey"}</h1>
    <p>{status.configured
      ? "Use one unused recovery code, then follow your phone or computer’s secure passkey prompt."
      : "Enter the one-time bootstrap code, then create a passkey using your phone, password manager, or this device."}</p>
    <form onSubmit={enroll}>
      <label htmlFor="admin-device-name">Device label</label>
      <input id="admin-device-name" autoComplete="off" minLength={2} maxLength={64} required placeholder="For example, Saurabh’s iPhone" value={deviceName} onChange={(event) => setDeviceName(event.target.value)} />
      {status.configured
        ? <><label htmlFor="admin-recovery-code">Recovery code</label><input id="admin-recovery-code" autoComplete="one-time-code" required value={recoveryCode} onChange={(event) => setRecoveryCode(event.target.value.toUpperCase())} /></>
        : <><label htmlFor="admin-bootstrap-code">One-time bootstrap code</label><input id="admin-bootstrap-code" type="password" autoComplete="new-password" minLength={16} maxLength={256} required value={bootstrapCode} onChange={(event) => setBootstrapCode(event.target.value)} /></>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary" disabled={busy}>{busy ? "Creating passkey…" : "Create passkey"}</button>
    </form>
    {status.configured && <button type="button" className="text-button" onClick={() => { setRecovering(false); setError(""); }}>Back to passkey sign-in</button>}
    <button type="button" className="text-button" onClick={() => void onLogout()}>Sign in with another email</button>
  </section></main>;
}
