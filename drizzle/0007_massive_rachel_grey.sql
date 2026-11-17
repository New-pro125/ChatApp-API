CREATE TABLE "chat_members" (
	"chat_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	CONSTRAINT "chat_members_pkey" PRIMARY KEY("chat_id","user_id"),
	CONSTRAINT "chat_members_role_check" CHECK ("chat_members"."role" in ('member', 'admin', 'owner'))
);
--> statement-breakpoint
CREATE TABLE "chats" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"type" text NOT NULL,
	"title" text,
	"direct_key" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chats_type_check" CHECK ("chats"."type" in ('direct', 'group', 'channel')),
	CONSTRAINT "chats_shape_check" CHECK (("chats"."type" = 'direct' and "chats"."title" is null and "chats"."direct_key" is not null) or ("chats"."type" <> 'direct' and "chats"."title" is not null and "chats"."direct_key" is null)),
	CONSTRAINT "chats_title_length_check" CHECK ("chats"."title" is null or char_length("chats"."title") between 1 and 128)
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"chat_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"type" text DEFAULT 'text' NOT NULL,
	"body" text,
	"reply_to_message_id" uuid,
	"forwarded_from_chat_id" uuid,
	"forwarded_from_message_id" uuid,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_pkey" PRIMARY KEY("chat_id","id"),
	CONSTRAINT "messages_type_check" CHECK ("messages"."type" in ('text', 'system')),
	CONSTRAINT "messages_body_length_check" CHECK ("messages"."body" is null or char_length("messages"."body") between 1 and 4096),
	CONSTRAINT "messages_text_body_check" CHECK ("messages"."type" <> 'text' or "messages"."body" is not null)
) PARTITION BY HASH ("chat_id");
--> statement-breakpoint
-- Hand-authored partitioning: Drizzle Kit cannot express PARTITION BY, so the
-- clause above and the sixteen child partitions below are maintained here.
-- Keep the modulus in sync with any future repartitioning migration.
CREATE TABLE "messages_p0" PARTITION OF "messages" FOR VALUES WITH (MODULUS 16, REMAINDER 0);
--> statement-breakpoint
CREATE TABLE "messages_p1" PARTITION OF "messages" FOR VALUES WITH (MODULUS 16, REMAINDER 1);
--> statement-breakpoint
CREATE TABLE "messages_p2" PARTITION OF "messages" FOR VALUES WITH (MODULUS 16, REMAINDER 2);
--> statement-breakpoint
CREATE TABLE "messages_p3" PARTITION OF "messages" FOR VALUES WITH (MODULUS 16, REMAINDER 3);
--> statement-breakpoint
CREATE TABLE "messages_p4" PARTITION OF "messages" FOR VALUES WITH (MODULUS 16, REMAINDER 4);
--> statement-breakpoint
CREATE TABLE "messages_p5" PARTITION OF "messages" FOR VALUES WITH (MODULUS 16, REMAINDER 5);
--> statement-breakpoint
CREATE TABLE "messages_p6" PARTITION OF "messages" FOR VALUES WITH (MODULUS 16, REMAINDER 6);
--> statement-breakpoint
CREATE TABLE "messages_p7" PARTITION OF "messages" FOR VALUES WITH (MODULUS 16, REMAINDER 7);
--> statement-breakpoint
CREATE TABLE "messages_p8" PARTITION OF "messages" FOR VALUES WITH (MODULUS 16, REMAINDER 8);
--> statement-breakpoint
CREATE TABLE "messages_p9" PARTITION OF "messages" FOR VALUES WITH (MODULUS 16, REMAINDER 9);
--> statement-breakpoint
CREATE TABLE "messages_p10" PARTITION OF "messages" FOR VALUES WITH (MODULUS 16, REMAINDER 10);
--> statement-breakpoint
CREATE TABLE "messages_p11" PARTITION OF "messages" FOR VALUES WITH (MODULUS 16, REMAINDER 11);
--> statement-breakpoint
CREATE TABLE "messages_p12" PARTITION OF "messages" FOR VALUES WITH (MODULUS 16, REMAINDER 12);
--> statement-breakpoint
CREATE TABLE "messages_p13" PARTITION OF "messages" FOR VALUES WITH (MODULUS 16, REMAINDER 13);
--> statement-breakpoint
CREATE TABLE "messages_p14" PARTITION OF "messages" FOR VALUES WITH (MODULUS 16, REMAINDER 14);
--> statement-breakpoint
CREATE TABLE "messages_p15" PARTITION OF "messages" FOR VALUES WITH (MODULUS 16, REMAINDER 15);
--> statement-breakpoint
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_members_user_id_index" ON "chat_members" USING btree ("user_id","chat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chats_direct_key_unique" ON "chats" USING btree ("direct_key") WHERE "chats"."direct_key" is not null;--> statement-breakpoint
CREATE INDEX "chats_created_by_index" ON "chats" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "messages_chat_id_created_at_index" ON "messages" USING btree ("chat_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);