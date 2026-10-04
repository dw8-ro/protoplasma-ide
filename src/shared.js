// Shared by the hub and lanes.

/** Terminal output kept per agent, so someone joining late sees the current screen. */
const SCROLLBACK = 256 * 1024;

/** Claude Code tools that change files. Edits through these are tracked for overlap warnings. */
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

/**
 * Appends terminal output to a scrollback buffer. Trims only past 2x the limit, so appends are amortised O(1)
 * instead of copying the whole buffer on every chunk.
 * TODO: the trimmed tail can start mid escape sequence. Replay through @xterm/headless if late joiners see glitches.
 */
const appendScrollback = (buf, data) => {
  buf += data;
  return buf.length > 2 * SCROLLBACK ? buf.slice(-SCROLLBACK) : buf;
};

/** A session name as a safe branch and folder name. Names that give the same slug are the same session. */
const slug = name => String(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'session';

module.exports = { SCROLLBACK, EDIT_TOOLS, appendScrollback, slug };
