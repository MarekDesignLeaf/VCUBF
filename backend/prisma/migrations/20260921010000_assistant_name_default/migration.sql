-- The assistant's name is account data, not a constant in the source. A new
-- company now starts from this default and can rename the assistant at any
-- time; existing accounts keep whatever name they already chose.
ALTER TABLE "users" ALTER COLUMN "assistant_name" SET DEFAULT 'Alfonzo';
ALTER TABLE "users" ALTER COLUMN "voice_wake_word" SET DEFAULT 'Hej Alfonzo';
