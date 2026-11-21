CREATE INDEX "messages_search_index" ON "messages" USING gin (to_tsvector(
  'english',
  coalesce("body", '') || ' ' || coalesce("caption", '')
));