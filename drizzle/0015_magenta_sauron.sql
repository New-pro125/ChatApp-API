CREATE TABLE "message_pins" (
	"chat_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"pinned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_pins_pkey" PRIMARY KEY("chat_id","user_id","message_id")
);
--> statement-breakpoint
ALTER TABLE "message_pins" ADD CONSTRAINT "message_pins_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_pins" ADD CONSTRAINT "message_pins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_pins_chat_user_pinned_at_index" ON "message_pins" USING btree ("chat_id","user_id","pinned_at" DESC NULLS LAST);