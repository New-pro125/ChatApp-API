ALTER TABLE "chat_members" ADD COLUMN "self_destruct_preset" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "messages_expires_at_index" ON "messages" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_self_destruct_preset_check" CHECK ("chat_members"."self_destruct_preset" is null or "chat_members"."self_destruct_preset" in ('24h', '7d', '90d'));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_expires_at_check" CHECK ("expires_at" is null or "expires_at" > "created_at");