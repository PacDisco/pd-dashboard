// Default wording for the ue-apply emails. Overridden per email in the
// PINNED COPY of ue-apply/public/emails.mjs.
// dashboard (Unearthed Application Form → Wording & emails). Pure; shared by
// the server (notify.mjs) and the dashboard editor (pinned copy).
export const DEFAULT_EMAILS = {
  resume: {
    subject: "Continue your Unearthed application — {{trip}}",
    body: "Hi {{studentFirst}},\n\nHere's your link to continue your application for {{trip}}:\n\n{{link}}\n\nThe link is personal to you, so please don't share it. If you didn't ask for this, you can ignore this email.",
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

