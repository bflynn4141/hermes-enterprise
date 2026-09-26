-- Unique subject key for auto-drafted contractor agreements after application admit.
CREATE UNIQUE INDEX IF NOT EXISTS requests_partner_contractor_agreement_key
  ON requests (workspace_id, subject_key)
  WHERE subject_key LIKE 'partner-contractor-agreement:%';
