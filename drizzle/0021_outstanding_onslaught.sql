CREATE TABLE "message_drafts" (
	"chat_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_drafts_pkey" PRIMARY KEY("chat_id","user_id"),
	CONSTRAINT "message_drafts_body_check" CHECK (char_length("message_drafts"."body") between 1 and 4096)
);
--> statement-breakpoint
ALTER TABLE "message_drafts" ADD CONSTRAINT "message_drafts_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_drafts" ADD CONSTRAINT "message_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;