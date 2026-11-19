ALTER TABLE "chat_members" ADD COLUMN "last_read_message_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_members" ADD COLUMN "last_read_at" timestamp with time zone;