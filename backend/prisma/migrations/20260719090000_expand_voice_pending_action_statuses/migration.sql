ALTER TABLE "voice_pending_actions"
  DROP CONSTRAINT IF EXISTS "voice_pending_actions_status_check";

ALTER TABLE "voice_pending_actions"
  ADD CONSTRAINT "voice_pending_actions_status_check"
  CHECK (
    "status" IN (
      'pending',
      'sending',
      'sent',
      'deleting',
      'archiving',
      'executing',
      'completed',
      'replaced',
      'cancelled',
      'expired',
      'failed'
    )
  );
