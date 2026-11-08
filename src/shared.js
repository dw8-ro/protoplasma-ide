// Shared by the hub and lanes.

/** Terminal output kept per agent, so someone joining late sees the current screen. */
const SCROLLBACK = 256 * 1024;

/** Claude Code tools that change files. Edits through these are tracked for overlap warnings. */
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

/**
 * Appends terminal output to a scrollback buffer. Trims only past 2x the limit, so appends are amortised O(1)
 * instead of copying the whole buffer on every chunk. The kept part starts after a line end, so a late joiner's replay
 * doesn't begin halfway through an escape sequence (printed as stray text); without one nearby, it's cut as it falls.
 */
const appendScrollback = (buf, data) => {
  buf += data;
  if (buf.length <= 2 * SCROLLBACK) return buf;
  const kept = buf.slice(-SCROLLBACK), line = kept.indexOf('\n');
  return line >= 0 && line < 4096 ? kept.slice(line + 1) : kept;
};

/** A session name as a safe branch and folder name. Names that give the same slug are the same session. */
// Letters of any script stay; a name with none (all emoji) gets a short code of its own instead of a shared one.
// Punctuation runs become one hyphen, so "fix - login" and "fix-login" are the same session.
const slug = name => {
  const s = String(name).toLowerCase().normalize('NFC').replace(/[\uFE00-\uFE0F\u200D\u20E3]/g, '');
  return s.replace(/[^\p{L}\p{M}\p{N}._-]+|\.{2,}/gu, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').replace(/(\.lock)+$/, '')
    || `session-${[...s].reduce((h, c) => (h * 33 + c.codePointAt(0)) >>> 0, 5381).toString(36)}`;
};

/** A hub certificate's fingerprint (sha256 of its DER bytes, base64url): what a pass names as the one hub it's for. */
const fingerprint = der => require('crypto').createHash('sha256').update(der).digest('base64url');

/** An agent's id, made from its hook secret, so only whoever holds the secret can connect under it. */
const laneIdOf = hookSecret => `h-${require('crypto').createHash('sha256').update(String(hookSecret)).digest('hex').slice(0, 32)}`;

module.exports = { SCROLLBACK, EDIT_TOOLS, appendScrollback, slug, fingerprint, laneIdOf };
