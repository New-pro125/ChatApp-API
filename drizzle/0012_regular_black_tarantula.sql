ALTER TABLE "messages" DROP CONSTRAINT "messages_type_check";--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_text_body_check";--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "media_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "media_kind" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "caption" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "width" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "height" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_media_id_media_objects_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_objects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_media_id_index" ON "messages" USING btree ("media_id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_media_shape_check" CHECK ("type" <> 'media' or "deleted_at" is not null or ("media_id" is not null and "media_kind" in ('image', 'video', 'document', 'voice_note', 'sticker', 'gif') and "body" is null and "ciphertext" is null and "nonce" is null and "ephemeral_public_key" is null and "sender_device_id" is null and "recipient_device_id" is null));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_non_media_no_media_check" CHECK ("type" = 'media' or ("media_id" is null and "media_kind" is null and "caption" is null and "duration_ms" is null and "width" is null and "height" is null));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_media_caption_check" CHECK ("caption" is null or char_length("caption") between 1 and 1000);--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_media_duration_check" CHECK ("duration_ms" is null or ("duration_ms" between 1 and 86400000));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_media_width_check" CHECK ("width" is null or ("width" between 1 and 16384));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_media_height_check" CHECK ("height" is null or ("height" between 1 and 16384));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_type_check" CHECK ("type" in ('text', 'system', 'secret', 'media'));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_text_body_check" CHECK ("type" not in ('text', 'media') or "body" is not null);