-- CP-CODE-001 follow-up: the original CHECK constraint on voice_pending_actions.status
-- listed only the e-mail sending states. The service layer has since added
-- 'deleting', 'archiving', 'executing' and 'replaced' (voiceNotificationService,
-- voiceGmailService, emmaExecutableActionService, ...). Environments created with
-- `prisma db push` never carried the constraint (Prisma does not manage CHECK
-- constraints), so the mismatch was invisible until CI switched to `migrate deploy`.
-- Re-create the constraint with the full state set used by the code.

ALTER TABLE "voice_pending_actions" DROP CONSTRAINT IF EXISTS "voice_pending_actions_status_check";

ALTER TABLE "voice_pending_actions"
  ADD CONSTRAINT "voice_pending_actions_status_check"
  CHECK ("status" IN (
    'pending', 'sending', 'sent', 'cancelled', 'expired', 'failed',
    'deleting', 'archiving', 'executing', 'replaced'
  )) NOT VALID;

-- Validate separately so existing rows are checked without a long exclusive lock.
ALTER TABLE "voice_pending_actions" VALIDATE CONSTRAINT "voice_pending_actions_status_check";
