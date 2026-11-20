CREATE TABLE "message_mentions" (
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"chat_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"mentioned_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "message_mentions_pkey" PRIMARY KEY("id")
);
--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_mentioned_user_id_users_id_fk" FOREIGN KEY ("mentioned_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_message_fk" FOREIGN KEY ("chat_id","message_id") REFERENCES "public"."messages"("chat_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_mentions_chat_message_user_unique" ON "message_mentions" USING btree ("chat_id","message_id","mentioned_user_id");--> statement-breakpoint
CREATE INDEX "message_mentions_user_inbox_idx" ON "message_mentions" USING btree ("mentioned_user_id","id" DESC NULLS LAST) WHERE "message_mentions"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "message_mentions_user_unread_idx" ON "message_mentions" USING btree ("mentioned_user_id","id" DESC NULLS LAST) WHERE "message_mentions"."deleted_at" is null and "message_mentions"."read_at" is null;