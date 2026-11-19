ALTER TABLE "message_pins" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "message_pins" SET "expires_at" = now() + interval '1 day';--> statement-breakpoint
ALTER TABLE "message_pins" ALTER COLUMN "expires_at" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "message_pins_expires_at_index" ON "message_pins" USING btree ("expires_at");
