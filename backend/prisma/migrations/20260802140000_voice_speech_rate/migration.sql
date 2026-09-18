-- How fast the assistant speaks, as a multiplier of the voice's natural
-- pace. Defaults above 1.0 because short confirmations read at the voice's
-- own speed sound sleepy.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "voice_speech_rate" DOUBLE PRECISION NOT NULL DEFAULT 1.15;
