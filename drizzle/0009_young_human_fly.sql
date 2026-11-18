CREATE TABLE "e2ee_devices" (
	"device_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"signing_public_key" text NOT NULL,
	"identity_public_key" text NOT NULL,
	"identity_signature" text NOT NULL,
	"signed_prekey_id" integer NOT NULL,
	"signed_prekey_public_key" text NOT NULL,
	"signed_prekey_signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	CONSTRAINT "e2ee_devices_signed_prekey_id_check" CHECK ("e2ee_devices"."signed_prekey_id" > 0),
	CONSTRAINT "e2ee_devices_key_material_check" CHECK (char_length("e2ee_devices"."signing_public_key") between 1 and 128 and char_length("e2ee_devices"."identity_public_key") between 1 and 128 and char_length("e2ee_devices"."identity_signature") between 1 and 128 and char_length("e2ee_devices"."signed_prekey_public_key") between 1 and 128 and char_length("e2ee_devices"."signed_prekey_signature") between 1 and 128)
);
--> statement-breakpoint
CREATE TABLE "e2ee_prekeys" (
	"device_id" uuid NOT NULL,
	"prekey_id" integer NOT NULL,
	"public_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "e2ee_prekeys_pkey" PRIMARY KEY("device_id","prekey_id"),
	CONSTRAINT "e2ee_prekeys_prekey_id_check" CHECK ("e2ee_prekeys"."prekey_id" > 0),
	CONSTRAINT "e2ee_prekeys_public_key_check" CHECK (char_length("e2ee_prekeys"."public_key") between 1 and 128)
);
--> statement-breakpoint
ALTER TABLE "chats" DROP CONSTRAINT "chats_type_check";--> statement-breakpoint
ALTER TABLE "chats" DROP CONSTRAINT "chats_shape_check";--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_type_check";--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "ciphertext" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "nonce" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "ephemeral_public_key" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sender_device_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "recipient_device_id" uuid;--> statement-breakpoint
ALTER TABLE "e2ee_devices" ADD CONSTRAINT "e2ee_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "e2ee_prekeys" ADD CONSTRAINT "e2ee_prekeys_device_id_e2ee_devices_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."e2ee_devices"("device_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "e2ee_devices_user_id_device_id_unique" ON "e2ee_devices" USING btree ("user_id","device_id");--> statement-breakpoint
CREATE INDEX "e2ee_prekeys_device_id_index" ON "e2ee_prekeys" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "messages_sender_device_id_index" ON "messages" USING btree ("chat_id","sender_device_id");--> statement-breakpoint
CREATE INDEX "messages_recipient_device_id_index" ON "messages" USING btree ("chat_id","recipient_device_id");--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_type_check" CHECK ("chats"."type" in ('direct', 'secret', 'group', 'channel'));--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_shape_check" CHECK (("chats"."type" in ('direct', 'secret') and "chats"."title" is null and "chats"."direct_key" is not null) or ("chats"."type" not in ('direct', 'secret') and "chats"."title" is not null and "chats"."direct_key" is null));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_secret_shape_check" CHECK ("type" <> 'secret' or ("body" is null and "ciphertext" is not null and "nonce" is not null and "ephemeral_public_key" is not null and "sender_device_id" is not null and "recipient_device_id" is not null));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_non_secret_no_ciphertext_check" CHECK ("type" = 'secret' or ("ciphertext" is null and "nonce" is null and "ephemeral_public_key" is null and "sender_device_id" is null and "recipient_device_id" is null));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_secret_no_reply_forward_check" CHECK ("type" <> 'secret' or ("reply_to_message_id" is null and "forwarded_from_chat_id" is null and "forwarded_from_message_id" is null));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_type_check" CHECK ("type" in ('text', 'system', 'secret'));