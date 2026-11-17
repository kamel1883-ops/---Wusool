-- Wusool — potential vs. human-verified leads.
--
-- A record discovered from open data (OpenStreetMap) or from a licensed feed is
-- a *potential* company: it exists in a public source, but nobody has confirmed
-- that it fits, that it wants the service, or that it may be contacted. Marking
-- it as qualified automatically would turn a directory match into a sales lead.
--
-- `classification` therefore starts as 'potential' for every record and only
-- becomes 'confirmed' through an explicit human action (a stage change out of
-- `new`, or recorded consent). Existing rows are potential too: they were never
-- verified individually.
ALTER TABLE leads ADD COLUMN classification TEXT NOT NULL DEFAULT 'potential';

CREATE INDEX IF NOT EXISTS idx_leads_company_classification ON leads(company_id, classification);
