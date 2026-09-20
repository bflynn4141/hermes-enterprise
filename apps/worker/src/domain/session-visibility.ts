// The session owner's conversation remains theirs when agent ownership changes.
// Session reads and snapshot hydration share this predicate without importing
// route handlers into the domain. Bind the viewer as $2 and alias sessions as s.
export const VISIBLE = `(s.owner_id = $2)`;
