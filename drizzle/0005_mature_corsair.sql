CREATE TABLE "user_blocks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"blocker_id" uuid NOT NULL,
	"blocked_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_blocks_no_self_block" CHECK ("user_blocks"."blocker_id" <> "user_blocks"."blocked_id")
);
--> statement-breakpoint
CREATE TABLE "user_privacy_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"profile_photo_visibility" text DEFAULT 'everyone' NOT NULL,
	"last_seen_visibility" text DEFAULT 'everyone' NOT NULL,
	"stories_visibility" text DEFAULT 'everyone' NOT NULL,
	"read_receipts_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_privacy_settings_profile_photo_visibility_check" CHECK ("user_privacy_settings"."profile_photo_visibility" in ('everyone', 'nobody')),
	CONSTRAINT "user_privacy_settings_last_seen_visibility_check" CHECK ("user_privacy_settings"."last_seen_visibility" in ('everyone', 'nobody')),
	CONSTRAINT "user_privacy_settings_stories_visibility_check" CHECK ("user_privacy_settings"."stories_visibility" in ('everyone', 'nobody'))
);
--> statement-breakpoint
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocker_id_users_id_fk" FOREIGN KEY ("blocker_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocked_id_users_id_fk" FOREIGN KEY ("blocked_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_privacy_settings" ADD CONSTRAINT "user_privacy_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_blocks_blocker_blocked_unique" ON "user_blocks" USING btree ("blocker_id","blocked_id");--> statement-breakpoint
CREATE INDEX "user_blocks_blocker_created_at_index" ON "user_blocks" USING btree ("blocker_id","created_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "user_blocks_blocked_id_index" ON "user_blocks" USING btree ("blocked_id");