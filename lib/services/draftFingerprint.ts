// Fingerprint of the wording a person sees on a step card. The approve call carries it, so an
// approval is only accepted for the exact wording that was on screen (an AI draft can arrive a
// moment after the page loaded and replace the template text). Not a security hash: it only has
// to notice that the text changed, and it runs in the browser and on the server.

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function draftFingerprint(draft: Record<string, unknown> | null, validation: Record<string, unknown> | null): string {
  const passed = validation !== null && validation.passed === true;
  // Stored letters (golden, sent steps) nest the text under draft.letter; AI drafts use subject and body.
  const letter = (draft?.letter ?? draft) as Record<string, unknown> | null;
  const subject = typeof letter?.subject === "string" ? letter.subject : "";
  const body = typeof letter?.body === "string" ? letter.body : "";
  return `${passed && body ? "ai" : "tpl"}:${body.length}:${fnv1a(`${subject}\n${body}`)}`;
}
