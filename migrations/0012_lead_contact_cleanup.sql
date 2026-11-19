-- Wusool — remove legacy leads that carry no direct contact.
--
-- Discovery now refuses any record without a phone number or an email, but
-- leads stored before that rule may still sit in the table with both fields
-- empty. Such a record can never be contacted, so it is deleted. A lead that
-- a human already worked on (any recorded activity) is kept: deleting it
-- would discard real sales history.
DELETE FROM leads
WHERE (email IS NULL OR TRIM(email) = '')
  AND (phone IS NULL OR TRIM(phone) = '')
  AND NOT EXISTS (
    SELECT 1 FROM lead_activities a WHERE a.lead_id = leads.id
  );
