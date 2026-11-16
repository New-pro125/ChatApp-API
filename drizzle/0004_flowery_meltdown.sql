ALTER TABLE "users" ADD COLUMN "username" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bio" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_lower_unique" ON "users" USING btree (lower("username"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_phone_unique" ON "users" USING btree ("phone");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_username_format" CHECK ("users"."username" is null or ("users"."username" = lower("users"."username") and "users"."username" ~ '^[a-z][a-z0-9_]{4,31}$'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_bio_length" CHECK ("users"."bio" is null or char_length("users"."bio") <= 70);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_phone_format" CHECK ("users"."phone" is null or "users"."phone" ~ '^\+[1-9][0-9]{7,14}$');--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_avatar_key_length" CHECK ("users"."avatar_key" is null or char_length("users"."avatar_key") between 1 and 512);