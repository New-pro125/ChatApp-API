DROP INDEX "messages_chat_id_created_at_index";--> statement-breakpoint
CREATE INDEX "messages_sender_id_index" ON "messages" USING btree ("sender_id");