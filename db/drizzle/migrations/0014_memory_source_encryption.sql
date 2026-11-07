ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "encrypted_content" text;
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "encryption_nonce" text;
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "is_encrypted" boolean DEFAULT false;
