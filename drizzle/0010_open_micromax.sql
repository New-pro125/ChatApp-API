CREATE TABLE "media_objects" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"scan_signature" text,
	"scan_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "media_objects_status_check" CHECK ("media_objects"."status" in ('pending', 'ready', 'quarantined', 'failed')),
	CONSTRAINT "media_objects_object_key_length_check" CHECK (char_length("media_objects"."object_key") between 1 and 512),
	CONSTRAINT "media_objects_content_type_length_check" CHECK (char_length("media_objects"."content_type") between 1 and 128),
	CONSTRAINT "media_objects_size_bytes_check" CHECK ("media_objects"."size_bytes" > 0),
	CONSTRAINT "media_objects_sha256_check" CHECK ("media_objects"."sha256" is null or "media_objects"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "media_objects_scan_signature_length_check" CHECK ("media_objects"."scan_signature" is null or char_length("media_objects"."scan_signature") between 1 and 512),
	CONSTRAINT "media_objects_scan_error_length_check" CHECK ("media_objects"."scan_error" is null or char_length("media_objects"."scan_error") between 1 and 512)
);
--> statement-breakpoint
ALTER TABLE "media_objects" ADD CONSTRAINT "media_objects_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "media_objects_object_key_unique" ON "media_objects" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "media_objects_owner_status_index" ON "media_objects" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE INDEX "media_objects_owner_created_at_index" ON "media_objects" USING btree ("owner_user_id","created_at" DESC NULLS LAST,"id");