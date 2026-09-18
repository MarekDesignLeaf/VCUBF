-- The wake word becomes "Hej Emma": two words are far harder to trigger by
-- accident than a single name, which the recogniser produced from room noise.
--
-- Only accounts still on the old default are moved. Anyone who chose their own
-- wake word keeps it.
ALTER TABLE "users" ALTER COLUMN "voice_wake_word" SET DEFAULT 'Hej Emma';

UPDATE "users" SET "voice_wake_word" = 'Hej Emma' WHERE "voice_wake_word" = 'Emma';
