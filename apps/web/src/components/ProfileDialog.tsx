import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { profileBadges, type ProfileBadgeId } from "@trinitymatrix/protocol";
import type { AuthPlayer, ProfileUpdate } from "../api";

export function ProfileDialog({
  player,
  onClose,
  onSave
}: {
  player: AuthPlayer;
  onClose: () => void;
  onSave: (profile: ProfileUpdate) => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState(player.displayName);
  const [badgeId, setBadgeId] = useState<ProfileBadgeId>(player.badgeId);
  const [countryCode, setCountryCode] = useState(player.phone?.countryCode ?? "+91");
  const [nationalNumber, setNationalNumber] = useState(player.phone?.nationalNumber ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => previousFocus?.focus();
  }, []);

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && !busy) onClose();
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])"
    ) ?? [])];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (document.activeElement === dialogRef.current) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSave({
        displayName: displayName.trim(),
        badgeId,
        phone: nationalNumber ? { countryCode, nationalNumber } : null
      });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save your profile.");
    } finally {
      setBusy(false);
    }
  };

  return <div className="modal-backdrop profile-backdrop" role="presentation">
    <section
      ref={dialogRef}
      className="profile-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="profile-title"
      tabIndex={-1}
      onKeyDown={handleDialogKeyDown}
    >
      <div className="profile-dialog-heading">
        <div>
          <span className="eyebrow">Player profile</span>
          <h2 id="profile-title">Make the table yours</h2>
        </div>
        <button type="button" className="profile-close" aria-label="Close profile" disabled={busy} onClick={onClose}>×</button>
      </div>

      <form onSubmit={submit}>
        <div className="profile-fields">
          <label htmlFor="profile-email">Email address</label>
          <input id="profile-email" type="email" value={player.email} readOnly aria-describedby="email-help" />
          <small id="email-help">Your verified sign-in email cannot be changed here.</small>

          <label htmlFor="profile-name">Display name</label>
          <input id="profile-name" autoComplete="nickname" minLength={2} maxLength={24} required value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
        </div>

        <fieldset className="badge-picker">
          <legend>Choose your profile badge</legend>
          <div className="badge-grid">
            {profileBadges.map((badge) => <label key={badge.id} className={badgeId === badge.id ? "selected" : ""}>
              <input type="radio" name="profile-badge" value={badge.id} checked={badgeId === badge.id} onChange={() => setBadgeId(badge.id)} />
              <span className="badge-symbol" aria-hidden="true">{badge.symbol}</span>
              <span><strong>{badge.label}</strong><small>{badge.description}</small></span>
            </label>)}
          </div>
        </fieldset>

        <fieldset className="phone-fields">
          <legend>Phone number <span>(optional)</span></legend>
          <div>
            <label htmlFor="country-code">ISD code</label>
            <input
              id="country-code"
              type="tel"
              inputMode="numeric"
              autoComplete="tel-country-code"
              pattern="[+][1-9][0-9]{0,2}"
              maxLength={4}
              required={Boolean(nationalNumber)}
              aria-describedby="phone-help"
              value={countryCode}
              onChange={(event) => setCountryCode(`+${event.target.value.replace(/\D/g, "").slice(0, 3)}`)}
            />
          </div>
          <div>
            <label htmlFor="phone-number">National number</label>
            <input
              id="phone-number"
              type="tel"
              inputMode="numeric"
              autoComplete="tel-national"
              pattern="[0-9]{4,14}"
              maxLength={14}
              placeholder="9876543210"
              aria-describedby="phone-help"
              value={nationalNumber}
              onChange={(event) => setNationalNumber(event.target.value.replace(/\D/g, "").slice(0, 14))}
            />
          </div>
          <small id="phone-help">Include the ISD code separately. The complete number is limited to 15 digits.</small>
        </fieldset>

        <p className="form-error" role="alert">{error}</p>
        <div className="dialog-actions profile-actions">
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy}>{busy ? "Saving…" : "Save profile"}</button>
        </div>
      </form>
    </section>
  </div>;
}
