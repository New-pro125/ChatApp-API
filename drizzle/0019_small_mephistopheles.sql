ALTER TABLE "messages" DROP CONSTRAINT "messages_media_id_media_objects_id_fk";
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_media_id_media_objects_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_objects"("id") ON DELETE set null ON UPDATE no action;