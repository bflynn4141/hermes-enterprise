-- Simulated effect execution.
--
-- Non-production environments may answer Execute on a legacy effect with a
-- synthetic outcome so the invoice, agreement and admission flows can be
-- followed to the end in a demo. The status is `simulated`, deliberately
-- distinct from `executed`: no payment, signature, mail or access action
-- occurred, and `enforcement_result` records the invented reference and
-- timeline. Production ignores the switch and keeps answering `unavailable`.

ALTER TABLE effects
  DROP CONSTRAINT IF EXISTS effects_status_check;

ALTER TABLE effects
  ADD CONSTRAINT effects_status_check
  CHECK (status IN ('pending', 'assigned', 'executed', 'cancelled', 'unavailable', 'failed', 'simulated'));
