-- 0002: conversation threading, send idempotency, and per-peer dedupe.
--
-- conversation_id was always carried in the IFP-4 envelope
-- (headers.conversation_id) but lived only inside the body blob, so it could
-- not be queried. Promote it to a column, backfill from existing bodies, and
-- index it per mailbox.
--
-- The unique index is the idempotency backstop. POST /ifp/<p>/<a>/inbox
-- already deduped in code; POST /api/v1/send did not, so a retried send wrote
-- a duplicate 'out' row for the sender, a duplicate 'in' row for the
-- recipient, and charged quota twice. Enforcing uniqueness in the schema
-- closes the check-then-insert race on both paths.
--
-- The index keys on peer as well as direction, which also fixes a pre-existing
-- flaw: the old inbound dedupe matched on (mailbox, 'in', message_id) with no
-- regard for who sent it, so two different senders that happened to choose the
-- same message_id would collide and the second one's mail would be silently
-- swallowed as a "redelivery". Dedupe is properly per-counterparty.

ALTER TABLE messages ADD COLUMN conversation_id TEXT;

UPDATE messages
   SET conversation_id = json_extract(body, '$.headers.conversation_id')
 WHERE conversation_id IS NULL;

CREATE INDEX idx_messages_conv ON messages (address_id, conversation_id, id);

-- Collapse any pre-existing duplicates (keep the earliest row) so the unique
-- index can be built on a live database that already took a duplicate send.
DELETE FROM messages
 WHERE ifp_message_id IS NOT NULL
   AND id NOT IN (
     SELECT MIN(id)
       FROM messages
      WHERE ifp_message_id IS NOT NULL
      GROUP BY address_id, direction, peer, ifp_message_id
   );

CREATE UNIQUE INDEX idx_messages_msgid
    ON messages (address_id, direction, peer, ifp_message_id)
 WHERE ifp_message_id IS NOT NULL;
