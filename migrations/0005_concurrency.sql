-- Wusool — per-plan concurrency for the analysis pipeline.
-- The effective limit is min(platform max_concurrent_jobs, plan max_concurrent).

ALTER TABLE plans ADD COLUMN max_concurrent INTEGER;

UPDATE plans SET max_concurrent = 1 WHERE id = 'plan_starter';
UPDATE plans SET max_concurrent = 2 WHERE id = 'plan_growth';
UPDATE plans SET max_concurrent = 4 WHERE id = 'plan_enterprise';
