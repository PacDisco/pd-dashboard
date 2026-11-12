// Default wording for the ue-apply emails. Overridden per email in the
// PINNED COPY of ue-apply/public/emails.mjs.
// dashboard (Unearthed Application Form → Wording & emails). Pure; shared by
// the server (notify.mjs) and the dashboard editor (pinned copy).
export const DEFAULT_EMAILS = {
  resume: {
    subject: "Continue your Unearthed application — {{trip}}",
    body: "Hi {{studentFirst}},\n\nHere's your link to continue your application for {{trip}}:\n\n{{link}}\n\nThe link is personal to you, so please don't share it. If you didn't ask for this, you can ignore this email.",
  },
  submitted: {
    subject: "Application received — {{student}}, {{trip}}",
    body: "Hi {{studentFirst}},\n\nThank you — we've received your application for {{trip}}.\n\nWhat happens next:\n\n1. A parent or legal guardian signs the permissions packet. If it isn't signed yet, they'll get (or have already got) an email with the link, or you can do it together from your application link.\n2. Pay the deposit to confirm your place — straight after signing, from the same page.\n\nWe'll email a copy of the signed permissions packet and a deposit receipt along the way.\n\nAny questions, reply to this email or call +64 (3) 288 2393.",
  },
  paymentFailed: {
    subject: "Your {{what}} didn't go through — {{trip}}",
    body: "Hi there,\n\nWe tried to process a {{amount}} {{what}} for {{student}} ({{trip}}), but it didn't go through.\n\nReason: {{reason}}\n\nNothing has been taken for this payment. Please try again here:\n\n{{link}}\n\nIf you think this is a mistake, or you'd like to pay another way, reply to this email or call +64 (3) 288 2393.",
  },
  signRequest: {
    subject: "Please sign {{studentFirst}}'s permissions packet — {{trip}}",
    body: "Hi {{parent}},\n\n{{student}} has applied for {{trip}} with Unearthed Education. Before they travel, a parent or legal guardian needs to read and sign the permissions packet (the agreement and, for students under 18, the medical authorisation).\n\nIt takes about 10 minutes, and {{studentFirst}}'s place isn't confirmed until it's signed. Once you've signed, the same page takes you to the deposit:\n\n{{link}}\n\nAny questions, reply to this email or call +64 (3) 288 2393.",
  },
  signed: {
    subject: "Signed: permissions packet for {{student}} — {{trip}}",
    body: "Hi {{parent}},\n\nThank you — the permissions packet for {{student}} ({{trip}}) is signed. A copy is attached for your records.",
  },
  deposit: {
    subject: "Deposit received — {{student}}, {{trip}}",
    body: "Hi {{studentFirst}},\n\nWe've received your deposit of {{amount}} for {{trip}} — your place is confirmed.\n\nYour Unearthed portal has your itinerary, packing list and the rest of your payment schedule:\n\n{{link}}\n\nWe can't wait to get started.",
  },
};

/**
 * The teacher & trip leader form's defaults where they differ (no parents, no
 * deposit). {{student}} / {{studentFirst}} are the applicant's own name there.
 */
export const DEFAULT_TEACHER_EMAILS = {
  submitted: {
    subject: "Application received — {{student}}, {{trip}}",
    body: "Hi {{studentFirst}},\n\nThank you — we've received your {{role}} application for {{trip}}.\n\nIf you haven't signed the waiver yet, please do that from your application link. Once it's signed, the Unearthed team will be in touch and will give you access to the trip in the leader portal.\n\nAny questions, reply to this email or call +64 (3) 288 2393.",
  },
  signed: {
    subject: "Signed: your waiver — {{trip}}",
    body: "Hi {{studentFirst}},\n\nThank you — your waiver for {{trip}} is signed. A copy is attached for your records.",
  },
};

/** The default for one email on a form (`teacher` → the teacher defaults where they exist). */
export const defaultEmail = (kind, formKind = 'student') => (formKind === 'teacher' && DEFAULT_TEACHER_EMAILS[kind]) || DEFAULT_EMAILS[kind];

