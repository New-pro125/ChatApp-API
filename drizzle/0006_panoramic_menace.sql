CREATE TABLE "stories" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"caption" text,
	"media_key" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stories_content_check" CHECK ("stories"."caption" is not null or "stories"."media_key" is not null),
	CONSTRAINT "stories_caption_length_check" CHECK ("stories"."caption" is null or char_length("stories"."caption") between 1 and 700),
	CONSTRAINT "stories_media_key_length_check" CHECK ("stories"."media_key" is null or char_length("stories"."media_key") between 1 and 512)
);
--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stories_user_created_at_index" ON "stories" USING btree ("user_id","created_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "stories_expires_at_index" ON "stories" USING btree ("expires_at");