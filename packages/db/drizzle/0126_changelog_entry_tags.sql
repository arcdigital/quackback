CREATE TABLE "changelog_entry_tags" (
	"changelog_entry_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "changelog_entry_tags" ADD CONSTRAINT "changelog_entry_tags_changelog_entry_id_changelog_entries_id_fk" FOREIGN KEY ("changelog_entry_id") REFERENCES "public"."changelog_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changelog_entry_tags" ADD CONSTRAINT "changelog_entry_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "changelog_entry_tags_pk" ON "changelog_entry_tags" USING btree ("changelog_entry_id","tag_id");--> statement-breakpoint
CREATE INDEX "changelog_entry_tags_changelog_id_idx" ON "changelog_entry_tags" USING btree ("changelog_entry_id");--> statement-breakpoint
CREATE INDEX "changelog_entry_tags_tag_id_idx" ON "changelog_entry_tags" USING btree ("tag_id");
