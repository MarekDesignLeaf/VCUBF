ALTER TABLE "users"
  ADD COLUMN "voice_wake_word" TEXT NOT NULL DEFAULT 'Emma',
  ADD COLUMN "voice_continuous" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "voice_language" TEXT NOT NULL DEFAULT 'en-GB';
