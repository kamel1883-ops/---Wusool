-- Wusool — social post review trail.
--
-- A post can be rejected or sent back for changes, so the decision, its reason
-- and the reviewer are stored on the post. Statuses are plain TEXT (no CHECK)
-- because this table already carries several post states; the API validates
-- the transitions.

ALTER TABLE social_posts ADD COLUMN review_note TEXT;
ALTER TABLE social_posts ADD COLUMN reviewed_by TEXT;
ALTER TABLE social_posts ADD COLUMN reviewed_at TEXT;
