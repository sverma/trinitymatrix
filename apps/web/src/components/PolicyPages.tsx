import type { ReactNode } from "react";
import { getPublicPolicyMetadata } from "../policy-metadata";

const policyMetadata = getPublicPolicyMetadata();

export const policyLastUpdated = policyMetadata.lastUpdated;

export const policyLinks = [
  { path: "/terms", label: "Terms of Service" },
  { path: "/privacy", label: "Privacy Policy" },
  { path: "/fair-play", label: "Game, ranking & fair-play rules" },
  { path: "/community-rules", label: "Community & chat rules" },
  { path: "/grievance", label: "Grievances & appeals" },
  { path: "/privacy-requests", label: "Data access & account deletion" },
  { path: "/contact", label: "Contact information" },
  { path: "/responsible-play", label: "Age & responsible play" }
] as const;

type PolicyPath = typeof policyLinks[number]["path"];
type PolicyPageDefinition = Readonly<{
  path: PolicyPath;
  eyebrow: string;
  title: string;
  summary: string;
  content: ReactNode;
}>;

const operatorIdentity = <strong>{policyMetadata.operatorLegalName}, {policyMetadata.operatorEntityType}, registration {policyMetadata.operatorRegistrationIdentifier}, with registered office at {policyMetadata.registeredAddress}</strong>;
const policyEmail = (address: string) => policyMetadata.publicationApproved
  ? <a href={`mailto:${address}`}>{address}</a>
  : <strong>{address}</strong>;

const regulatoryReferences = <section>
  <h2>Regulatory references</h2>
  <p>These links are provided for transparency and do not replace legal advice:</p>
  <ul>
    <li><a href="https://www.indiacode.nic.in/indiacode/handle/123456789/22148?view_type=search">Promotion and Regulation of Online Gaming Act, 2025</a></li>
    <li><a href="https://www.meity.gov.in/static/uploads/2026/04/7e0b02d37fd07f81fa48578a9996aa85.pdf">Promotion and Regulation of Online Gaming Rules, 2026</a></li>
    <li><a href="https://www.indiacode.nic.in/indiacode/handle/123456789/22037?view_type=browse">Digital Personal Data Protection Act, 2023</a></li>
    <li><a href="https://www.meity.gov.in/documents/act-and-policies/digital-personal-data-protection-rules-2025-gDOxUjMtQWa?hl=en-US">Digital Personal Data Protection Rules, 2025</a></li>
  </ul>
  <p className="policy-reference-note">Open government links may download a PDF or open a new government website.</p>
 </section>;

const policyPages: readonly PolicyPageDefinition[] = [
  {
    path: "/terms",
    eyebrow: "Legal",
    title: "Terms of Service",
    summary: "The agreement governing access to the free TrinityMatrix service.",
    content: <>
      <section>
        <h2>1. Operator and agreement</h2>
        <p>TrinityMatrix is operated by {operatorIdentity} ("TrinityMatrix", "we", "us" or "our"). These Terms form a binding agreement between the operator and each person who accesses TrinityMatrix. By creating an account, joining a table or otherwise using the service, you agree to these Terms and the policies linked below.</p>
        {!policyMetadata.publicationApproved && <p><strong>Launch blocker:</strong> the operator identity, registered address, governing-law venue and contact mailboxes must be completed and approved by qualified Indian counsel before these Terms are published as final.</p>}
      </section>
      <section>
        <h2>2. Eligibility</h2>
        <ul>
          <li>You must be at least 18 years old and legally capable of entering into this agreement.</li>
          <li>You may use TrinityMatrix only where online social card games are lawful for you. You are responsible for complying with laws that apply at your location.</li>
          <li>You must provide accurate account information, use only your own email address and keep access to that email secure.</li>
          <li>One person may not operate multiple accounts to manipulate matchmaking, rankings or another player.</li>
        </ul>
      </section>
      <section>
        <h2>3. Free social game only</h2>
        <p>The current service offers free 2-player and 6-player Trinity games. TrinityMatrix does not accept stakes, deposits, entry fees, wagers or cryptocurrency and does not award cash, cash-equivalent prizes or anything convertible to money. Rankings, ratings and badges have no monetary value and cannot be transferred.</p>
        <p>Any future paid or prize feature would require a separate legal, regulatory, product and policy release. These Terms do not authorize such a feature.</p>
      </section>
      <section>
        <h2>4. Account licence and acceptable use</h2>
        <p>We grant you a limited, personal, revocable, non-exclusive and non-transferable licence to use TrinityMatrix for lawful recreational play. You must not:</p>
        <ul>
          <li>use bots, automation, scripts, collusion, account sharing, hidden coordination or unauthorized assistance;</li>
          <li>exploit bugs, tamper with traffic, reverse engineer security controls, scrape the service, overwhelm infrastructure or attempt unauthorized access;</li>
          <li>harass another person, impersonate anyone, publish personal information or use chat unlawfully;</li>
          <li>sell, transfer or commercially exploit an account, invitation, rating or service access; or</li>
          <li>use the service in breach of our fair-play or community rules.</li>
        </ul>
      </section>
      <section>
        <h2>5. Games, records and decisions</h2>
        <p>Game outcomes are determined by the server under the published game rules. Network interruptions, timeouts, drops and reconnections are handled by those rules. The authoritative game event record is used to investigate disputes. Rankings are an entertainment feature and may be corrected where a bug, abuse or data error affected a result.</p>
        <p>We do not place platform-controlled bots into human matchmaking. A player using unauthorized automation violates these Terms and may be removed after investigation.</p>
      </section>
      <section>
        <h2>6. Suspension, termination and service changes</h2>
        <p>We may warn, restrict, suspend or close an account where reasonably necessary to protect players, investigate abuse, comply with law or maintain service integrity. Except where urgent action is required, we will provide a reason and an appeal route. You may stop using the service or request account deletion at any time.</p>
        <p>We may maintain, change or discontinue features. We will use reasonable efforts to give notice of a material adverse change, but uninterrupted or error-free availability is not guaranteed.</p>
      </section>
      <section>
        <h2>7. Intellectual property and player content</h2>
        <p>TrinityMatrix software, artwork, names and service content are owned by the operator or its licensors. You retain rights you hold in content you submit. You give us a limited licence to host, transmit, store, moderate and display that content solely to operate, secure and improve the service and to meet legal obligations.</p>
        <p>The project's source code is separately licensed under the GNU Affero General Public License version 3 only (AGPL-3.0-only). These hosted-service Terms do not reduce the rights granted by that license to use, modify, redistribute or operate your own copy of the covered software. Preserve applicable third-party notices and do not claim that a separately operated service is endorsed by TrinityMatrix.</p>
      </section>
      <section>
        <h2>8. Disclaimers and liability</h2>
        <p>The service is provided on an "as available" basis. To the maximum extent permitted by applicable law, we exclude implied warranties that may lawfully be excluded. Nothing in these Terms limits liability that cannot lawfully be limited, or limits your mandatory consumer or data-protection rights.</p>
      </section>
      <section>
        <h2>9. Governing law and disputes</h2>
        <p>These Terms are governed by the laws of India. Subject to mandatory rights and the grievance and appeal process, courts at <strong>{policyMetadata.jurisdictionCity}, {policyMetadata.jurisdictionState}</strong> will have jurisdiction. Contact the grievance officer first so we have an opportunity to resolve the issue.</p>
      </section>
      <section>
        <h2>10. Changes and contact</h2>
        <p>We will post updated Terms with a new effective date. If a material change requires fresh notice or consent, we will provide it before the change applies. Questions may be sent to {policyEmail(policyMetadata.supportEmail)}.</p>
      </section>
      {regulatoryReferences}
    </>
  },
  {
    path: "/privacy",
    eyebrow: "Privacy",
    title: "Privacy Policy",
    summary: "How TrinityMatrix collects, uses, shares, secures and retains personal data.",
    content: <>
      <section>
        <h2>1. Data fiduciary</h2>
        <p>The data fiduciary for TrinityMatrix is {operatorIdentity}.</p>
        {!policyMetadata.publicationApproved && <p>Before launch, the operator must publish a working privacy mailbox, grievance contact and registered address.</p>}
      </section>
      <section>
        <h2>2. Data we collect</h2>
        <ul>
          <li><strong>Account and profile:</strong> email address, display name, profile badge, optional phone number and country/ISD code, account timestamps and status.</li>
          <li><strong>Authentication and security:</strong> one-time-code challenge records, session identifiers, IP address, user agent, request and security logs. We do not store the plain OTP after verification.</li>
          <li><strong>Gameplay:</strong> table name and ID, participants, invitations, cards and server-authoritative moves, timestamps, outcomes, drops, ratings, match history and replay events.</li>
          <li><strong>Community:</strong> post-game messages, their author and timestamp, reports, moderation decisions, grievances and appeals. Chat content is encrypted at rest, but authorized administrators can decrypt it for moderation, safety, support and audit.</li>
          <li><strong>Technical:</strong> connection status, reconnect events, errors, performance measurements and device/browser information.</li>
        </ul>
        <p>If another player invites you to a private table, we receive the email address they entered even before you accept the invitation.</p>
      </section>
      <section>
        <h2>3. Why we use data</h2>
        <p>We use personal data to authenticate players; operate matchmaking, games, rankings, replay and chat; deliver invitations and service emails; prevent fraud, bots, collusion and attacks; restore interrupted games; moderate content; provide support and grievance handling; maintain records; comply with law; and understand aggregate service reliability.</p>
        <p>Where consent is the applicable basis, you may withdraw it as easily as you gave it. Withdrawal does not affect processing already lawfully completed and may make the account or a requested feature unusable.</p>
      </section>
      <section>
        <h2>4. Sharing and processors</h2>
        <p>We do not sell personal data. We may disclose the minimum necessary data to hosting, database, cache, monitoring, security and email-delivery providers acting under contract; professional advisers and auditors; a successor in a corporate transaction; or authorities where law requires it or where necessary to protect rights and safety.</p>
        <p>Hosting, storage, monitoring and transactional-email providers are deployment-specific. The production version of this Policy must identify the providers actually enabled for that installation before publication.</p>
        {!policyMetadata.publicationApproved && <p>Before launch, the operator must complete and publish the processor list, processing locations and international-transfer assessment.</p>}
      </section>
      <section>
        <h2>5. Retention</h2>
        <p>We keep data only for a documented purpose and retention period. Authentication challenges are short-lived. Account, gameplay, replay, ranking, safety, chat and audit records may be retained after a match or account closure where needed for integrity, disputes, security or law. We delete or irreversibly anonymize data when the purpose and applicable retention obligation end.</p>
        {!policyMetadata.publicationApproved && <p><strong>Launch blocker:</strong> legal, security and product owners must approve the production retention schedule, including exact periods for each category, backup expiry and legal holds.</p>}
      </section>
      <section>
        <h2>6. Security</h2>
        <p>Controls include encrypted transport, access controls, least-privilege administration, encrypted storage and backups, secret management, audit records and monitoring. No system is perfectly secure. If a personal-data breach requires notice, we will notify affected people and the relevant authority in the manner required by applicable law.</p>
      </section>
      <section>
        <h2>7. Your choices and rights</h2>
        <p>Subject to applicable law, you may request a summary of your data and processing, correction or completion, erasure, grievance redressal and nomination of another person to exercise rights in the event of death or incapacity. You may also edit supported profile fields in the product and request account deletion. We may verify your identity and may retain limited information where an exception or legal obligation applies.</p>
        <p>Use the <a href="/privacy-requests">data access and account deletion process</a>. Complaints may be sent through the <a href="/grievance">grievance process</a>.</p>
      </section>
      <section>
        <h2>8. Children</h2>
        <p>TrinityMatrix is restricted to people aged 18 or older and is not directed to children. If you believe a child has created an account, contact us so we can investigate and take appropriate action.</p>
      </section>
      <section>
        <h2>9. Device storage and updates</h2>
        <p>We use strictly necessary cookies or equivalent browser storage for sessions, security, preferences and controlled PWA operation. The current service does not use third-party advertising trackers. We will update this Policy before introducing materially different tracking or processing.</p>
        <p>Material changes will be shown with a revised date and, where required, a fresh notice or consent request.</p>
      </section>
      {regulatoryReferences}
    </>
  },
  {
    path: "/fair-play",
    eyebrow: "Rules",
    title: "Game, ranking and fair-play rules",
    summary: "The rules used to conduct matches and protect competitive integrity.",
    content: <>
      <section>
        <h2>1. Current game format</h2>
        <p>TrinityMatrix currently offers free 2-player and 6-player Trinity. Each player receives 13 cards and takes turns drawing and discarding. A valid declaration follows every rule below:</p>
        <ul>
          <li><strong>Cards and values:</strong> number cards use their printed value; Jack, Queen and King are worth 10; an Ace may be worth 1 or 11.</li>
          <li><strong>Meld size:</strong> every meld contains at least three cards.</li>
          <li><strong>Suit pattern:</strong> the natural cards in a meld are all one suit or all different suits.</li>
          <li><strong>Meld total:</strong> every meld totals 3, 6, 9, 12, 15, 18, 21, 24 or 27. A total above 27 is invalid even when divisible by three.</li>
          <li><strong>Declaration:</strong> every remaining card belongs to exactly one valid meld, and at least one natural-card meld totals exactly 21.</li>
        </ul>
        <p>Printed jokers and cards matching the selected wild rank are exempt from suit matching and can represent card values in other valid melds. A 21-point Trinity meld cannot contain either kind of wild card. The server, not the browser, validates commands and outcomes.</p>
        <p>The printed joker and the selected wild rank are treated according to the rules shown at the table. The in-game meld labels are guidance; the authoritative declaration result comes from server validation.</p>
      </section>
      <section>
        <h2>2. Match types and ratings</h2>
        <ul>
          <li><strong>General matches:</strong> public matchmaking, ranked, with 2 or 6 human players.</li>
          <li><strong>Private matches:</strong> invite-only and unranked unless the interface expressly says otherwise.</li>
          <li><strong>Ratings:</strong> start from the service baseline and change after a completed ranked match using the published TrinityMatrix rating calculation. Rankings may be recalculated to correct duplicate, fraudulent or technically invalid results.</li>
        </ul>
      </section>
      <section>
        <h2>3. Turns, connection loss and dropping</h2>
        <p>Players must act within the table timer. A reconnecting player receives the authoritative current state; a disconnected browser does not pause the table. Choosing “Drop game,” abandoning a game or exhausting applicable timers may count as a drop or loss under the table rules. A completed server record controls if screens temporarily disagree.</p>
      </section>
      <section>
        <h2>4. Human-only matchmaking</h2>
        <p>TrinityMatrix does not insert platform-controlled bots into human matchmaking. All displayed seats are associated with authenticated player accounts. This does not guarantee that another person will never attempt unauthorized automation, so we monitor and investigate suspicious play.</p>
      </section>
      <section>
        <h2>5. Prohibited conduct</h2>
        <ul>
          <li>bots, macros, scripts, automated decision tools or unauthorized game clients;</li>
          <li>collusion, signaling hands, coordinated dropping, win trading or sharing one account;</li>
          <li>using multiple accounts to influence matchmaking or ratings;</li>
          <li>exploiting a bug, viewing another hand, tampering with messages or interfering with service availability; and</li>
          <li>harassing, bribing or threatening another player about an outcome.</li>
        </ul>
      </section>
      <section>
        <h2>6. Enforcement and appeals</h2>
        <p>We may invalidate a match, reverse a rating change, restrict matchmaking, suspend an account or preserve evidence while investigating. We consider game events, security logs and relevant communications. Affected players may appeal through the <a href="/grievance">grievance and appeal process</a>. We will not disclose detection details that would help evasion or another player’s private data.</p>
      </section>
      <section>
        <h2>7. Rule changes</h2>
        <p>Material gameplay or rating changes will be versioned and announced before they affect new matches. A match uses the rules and compatible game version assigned when it starts.</p>
      </section>
    </>
  },
  {
    path: "/community-rules",
    eyebrow: "Community",
    title: "Community and post-game chat rules",
    summary: "Simple standards for respectful, safe post-game conversation.",
    content: <>
      <section>
        <h2>1. Chat format</h2>
        <p>Post-game chat is available to the players in a completed table. Each player may send up to three messages to the group, and each message may contain up to 280 characters. Messages include an author and timestamp and are retained for replay, moderation, safety and audit under the Privacy Policy.</p>
      </section>
      <section>
        <h2>2. Keep it respectful and safe</h2>
        <p>Do not send harassment, threats, hate speech, sexual content, spam, scams, malware, unlawful content or instructions to cheat. Do not reveal another person’s identity, contact details, precise location or other private information. Avoid sharing your own sensitive personal or financial information.</p>
      </section>
      <section>
        <h2>3. No off-platform money play</h2>
        <p>Do not solicit wagers, deposits, cryptocurrency transfers, paid rematches or other financial arrangements. TrinityMatrix is free play only. Private tables are invitations to play, not a payment or betting channel.</p>
      </section>
      <section>
        <h2>4. Moderation and evidence</h2>
        <p>Chat is encrypted at rest, but authorized administrators can decrypt messages when necessary for moderation, support, a grievance, safety, security or a lawful request. Access should be logged and limited to trained personnel. We may hide content, warn or restrict a user, suspend an account and preserve relevant evidence.</p>
      </section>
      <section>
        <h2>5. Reporting and appeals</h2>
        <p>Until an in-product report control is released, include the table name, approximate time and reason in an email to {policyEmail(policyMetadata.grievanceEmail)}. Do not forward unnecessary personal information. A player affected by a moderation decision may use the <a href="/grievance">appeal process</a>.</p>
      </section>
    </>
  },
  {
    path: "/grievance",
    eyebrow: "Support",
    title: "Grievance and appeal process",
    summary: "How to raise game, account, privacy, safety or moderation concerns.",
    content: <>
      <section>
        <h2>1. Submit a grievance</h2>
        <p>Email {policyEmail(policyMetadata.grievanceEmail)} from the email attached to your account. Use a subject such as “Game grievance,” “Privacy grievance,” “Chat report” or “Account appeal.” Include your display name, the table name and date if relevant, what happened, the outcome you request and any supporting screenshot. Never send your OTP or password.</p>
        <p>The appointed grievance officer is <strong>{policyMetadata.grievanceOfficerName}</strong>, reachable by post at <strong>{policyMetadata.grievanceOfficerAddress}</strong>.</p>
        {!policyMetadata.publicationApproved && <p><strong>Launch blocker:</strong> provision and monitor the grievance mailbox and approve the officer’s published Indian contact details.</p>}
      </section>
      <section>
        <h2>2. What happens next</h2>
        <ol>
          <li>We aim to acknowledge a complete grievance within 24 hours and assign a reference number.</li>
          <li>We may ask for identity verification or narrowly relevant information.</li>
          <li>We aim to issue a reasoned response within 15 days, or sooner where law requires. Complex security or multi-party matters may take longer; if so, we will provide a status update.</li>
          <li>Urgent safety, impersonation or unlawful-content reports are triaged promptly.</li>
        </ol>
      </section>
      <section>
        <h2>3. Internal appeal</h2>
        <p>If you disagree with the decision, reply within 30 days with “Appeal” in the subject, your reference number and the specific reason for review. Someone not responsible for the original decision should review the available record where practicable.</p>
      </section>
      <section>
        <h2>4. External routes</h2>
        <p>Nothing here limits a right to contact a regulator, court or other authority. Under rule 20 of the Promotion and Regulation of Online Gaming Rules, 2026, an eligible user dissatisfied with the provider’s resolution, or whose grievance is not resolved within the applicable timeline, may approach the Online Gaming Authority of India within 30 days using the Authority’s published digital process. Other statutory appeal or privacy routes may also apply.</p>
      </section>
      <section>
        <h2>5. Fair process</h2>
        <p>We preserve relevant records, limit access, avoid retaliation for good-faith reports and provide only information we may lawfully disclose. We may reject abusive, duplicative or knowingly false submissions while retaining a record of the decision.</p>
      </section>
      {regulatoryReferences}
    </>
  },
  {
    path: "/privacy-requests",
    eyebrow: "Privacy",
    title: "Data access and account deletion",
    summary: "How to exercise privacy rights or close a TrinityMatrix account.",
    content: <>
      <section>
        <h2>1. Available requests</h2>
        <p>Subject to applicable law, you may ask for a summary of personal data and processing, correction or completion of inaccurate data, erasure, withdrawal of consent, grievance redressal or nomination of another person to exercise rights in the event of death or incapacity.</p>
      </section>
      <section>
        <h2>2. How to submit</h2>
        <ol>
          <li>Email {policyEmail(policyMetadata.privacyEmail)} from the address used for your account.</li>
          <li>Use “Data request” or “Delete my account” as the subject and state the request clearly.</li>
          <li>Complete a proportionate identity check. We will never ask for an OTP in an email reply.</li>
          <li>We will acknowledge the request and explain the expected response time or any information needed to proceed.</li>
        </ol>
        {!policyMetadata.publicationApproved && <p><strong>Launch blocker:</strong> provision this mailbox, designate request owners and test the documented export/deletion workflow before production traffic.</p>}
      </section>
      <section>
        <h2>3. Account deletion</h2>
        <p>Deletion disables sign-in and removes or de-identifies profile and personal data that is no longer required. Completed game integrity may require us to retain a pseudonymous participant record, game events, rating effects, security evidence, grievances or audit records for the approved retention period. Other players may retain access to a completed game replay or chat record where legally permitted, but deleted-account identity should be minimized.</p>
        <p>Data in encrypted backups is not immediately edited; it expires under the backup schedule and remains protected and unavailable for ordinary use. A legal hold, unresolved dispute, fraud investigation or legal duty may delay deletion of narrowly relevant records.</p>
      </section>
      <section>
        <h2>4. Data export</h2>
        <p>Where applicable, an export may include profile data, match participation, ranking history, post-game messages and relevant account metadata in a commonly readable format. It will not expose another player’s private data, anti-abuse detection logic, secrets or information we cannot lawfully disclose.</p>
      </section>
      <section>
        <h2>5. Appeal or complaint</h2>
        <p>If a request is refused or limited, we will explain why unless law prevents it. You may use the <a href="/grievance">grievance and appeal process</a> and any applicable statutory route.</p>
      </section>
      {regulatoryReferences}
    </>
  },
  {
    path: "/contact",
    eyebrow: "Contact",
    title: "Business, privacy and grievance contacts",
    summary: "The official channels for TrinityMatrix business and player matters.",
    content: <>
      <section>
        <h2>Operator</h2>
        <dl className="contact-list">
          <div><dt>Legal entity</dt><dd>{policyMetadata.operatorLegalName} ({policyMetadata.operatorEntityType}; registration {policyMetadata.operatorRegistrationIdentifier})</dd></div>
          <div><dt>Registered office</dt><dd>{policyMetadata.registeredAddress}</dd></div>
          <div><dt>Website</dt><dd>This installation’s public origin</dd></div>
        </dl>
      </section>
      <section>
        <h2>Email channels</h2>
        <dl className="contact-list">
          <div><dt>Player support</dt><dd>{policyEmail(policyMetadata.supportEmail)}</dd></div>
          <div><dt>Privacy and data rights</dt><dd>{policyEmail(policyMetadata.privacyEmail)}</dd></div>
          <div><dt>Grievance officer</dt><dd>{policyMetadata.grievanceOfficerName}; {policyEmail(policyMetadata.grievanceEmail)}; {policyMetadata.grievanceOfficerAddress}</dd></div>
          <div><dt>Security reports</dt><dd>{policyEmail(policyMetadata.securityEmail)}</dd></div>
          <div><dt>Business enquiries</dt><dd>{policyEmail(policyMetadata.businessEmail)}</dd></div>
        </dl>
        {!policyMetadata.publicationApproved && <p>These addresses are reserved policy destinations, not confirmation that the mailboxes exist. DNS, inbound delivery, access control, backups and on-call ownership must be tested before launch.</p>}
      </section>
      <section>
        <h2>Security reporting</h2>
        <p>Send a concise description, affected URL, steps to reproduce and impact. Do not access other players’ data, disrupt service, demand payment, publish an unpatched issue or retain unnecessary data. We will acknowledge good-faith reports and coordinate remediation where appropriate.</p>
      </section>
      <section>
        <h2>Not for emergencies</h2>
        <p>TrinityMatrix contact channels are not emergency services. If someone is at immediate risk, contact local emergency services or an appropriate local authority.</p>
      </section>
    </>
  },
  {
    path: "/responsible-play",
    eyebrow: "Player wellbeing",
    title: "Age policy and responsible play",
    summary: "Age limits and practical tools for healthy recreational play.",
    content: <>
      <section>
        <h2>Adults only</h2>
        <p>You must be at least 18 years old to create or use a TrinityMatrix account. The service is not directed to children. We may request proportionate age assurance, restrict an account while reviewing eligibility and close an underage account.</p>
        <p>A parent or guardian who believes a child is using TrinityMatrix should contact {policyEmail(policyMetadata.grievanceEmail)} with enough information for us to investigate, without sending unnecessary sensitive documents.</p>
      </section>
      <section>
        <h2>Free play means no financial risk</h2>
        <p>TrinityMatrix currently has no stakes, deposits, wallets, paid entry, cash prizes, cryptocurrency or cash-equivalent rewards. Never pay another player for a match or accept an off-platform wager. Rankings and badges have no monetary value.</p>
      </section>
      <section>
        <h2>Play with balance</h2>
        <ul>
          <li>Choose a time limit before joining a table and take regular breaks.</li>
          <li>Do not play when it interferes with sleep, health, relationships, study or work.</li>
          <li>Stop if play causes distress, anger or compulsive checking of rank.</li>
          <li>Do not chase a rating loss. Rankings are recreational and can change.</li>
          <li>Mute notifications, sign out or request a cooling-off restriction if you need distance.</li>
        </ul>
      </section>
      <section>
        <h2>Cooling off and self-exclusion</h2>
        <p>Until self-service controls are available, request a temporary restriction or account closure through {policyEmail(policyMetadata.supportEmail)}. State the desired period. We will not reverse an active cooling-off period merely to restore immediate play, except to correct an error after verification.</p>
        {!policyMetadata.publicationApproved && <p><strong>Launch blocker:</strong> operations must implement, test and document the cooling-off and age-escalation workflows before production promotion.</p>}
      </section>
      <section>
        <h2>Getting help</h2>
        <p>If gaming or online activity is affecting your wellbeing, consider speaking with someone you trust or a qualified health professional in your location. TrinityMatrix does not provide medical advice or crisis support.</p>
      </section>
      {regulatoryReferences}
    </>
  }
] as const;

export function getPolicyPage(pathname: string) {
  const normalizedPath = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return policyPages.find(({ path }) => path === normalizedPath) ?? null;
}

export function PolicyFooter({ compact = false }: { compact?: boolean }) {
  return <footer className={`policy-footer${compact ? " compact-policy-footer" : ""}`}>
    <nav aria-label="Policies and support">
      {policyLinks.map(({ path, label }) => <a key={path} href={path}>{label}</a>)}
    </nav>
    <p>TrinityMatrix · Free social play · 18+ · No stakes, prizes or payments</p>
    <p><a href="https://github.com/sverma/trinitymatrix">Source code · AGPL-3.0</a></p>
  </footer>;
}

export function PolicyPage({ page }: { page: PolicyPageDefinition }) {
  return <main id="main-content" className="policy-shell">
    <header className="policy-header">
      <a className="wordmark" href="/" aria-label="TrinityMatrix home"><span>TM</span> TrinityMatrix</a>
      <a className="secondary policy-back-link" href="/">Back to game</a>
    </header>
    <article className="policy-article">
      <div className="policy-title">
        <span className="eyebrow">{page.eyebrow}</span>
        <h1>{page.title}</h1>
        <p>{page.summary}</p>
        <p className="policy-date">{policyMetadata.publicationApproved ? "Effective" : "Draft last updated"} {policyMetadata.publicationApproved ? policyMetadata.effectiveDate : policyLastUpdated} · Version {policyMetadata.policyVersion}</p>
      </div>
      <aside className="policy-draft-notice" role="note" aria-label="Publication status">
        <strong>{policyMetadata.publicationApproved ? "Published production policy" : "Draft — not approved for production publication"}</strong>
        <span>{policyMetadata.publicationApproved
          ? `Effective ${policyMetadata.effectiveDate}; last updated ${policyMetadata.lastUpdated}.`
          : "Operator details, operational mailboxes, retention periods and legal approval must be completed before launch."}</span>
      </aside>
      <nav className="policy-index" aria-label="Policy pages">
        {policyLinks.map(({ path, label }) => <a key={path} href={path} aria-current={path === page.path ? "page" : undefined}>{label}</a>)}
      </nav>
      <div className="policy-content">{page.content}</div>
    </article>
    <PolicyFooter />
  </main>;
}
